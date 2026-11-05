import { readFile } from 'node:fs/promises';

import Fastify, { type FastifyInstance } from 'fastify';

import {
  AgentLoop,
  ApprovalGate,
  createBuiltinTools,
  FakeProvider,
  ProviderGateway,
  ToolRegistry,
  type ModelProvider,
  type ModelTier,
} from '@rakko/core';
import {
  approvalDecisionSchema,
  createRunInput,
  createThreadInput,
  type Run,
  type RunEvent,
  type RunState,
} from '@rakko/protocol';

import { MemoryStore, type RunStore } from './store.js';

const invalid = (issues: unknown[]) => ({ error: 'invalid_request', message: '请求体不合法', issues });

export const FAKE_MODELS: Record<ModelTier, string> = { standard: 'fake-standard', fast: 'fake-fast' };

export interface AppOptions {
  store?: RunStore;
  gateway?: ProviderGateway;
  /** 没给 gateway 时的便捷入口，默认假 provider */
  provider?: ModelProvider;
  /** 不传就用工作区的内置工具（读、列、写、跑命令） */
  tools?: ToolRegistry;
  workspace?: string;
  approvalTimeoutMs?: number;
  maxSteps?: number;
}

export function createApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const store = options.store ?? new MemoryStore();
  const gateway =
    options.gateway ??
    new ProviderGateway({
      provider: options.provider ?? new FakeProvider(),
      models: FAKE_MODELS,
      firstChunkTimeoutMs: 5_000,
    });

  const workspace = options.workspace ?? process.cwd();
  const tools = options.tools ?? new ToolRegistry({ workspace });
  if (!options.tools) {
    for (const tool of createBuiltinTools({ workspace })) tools.register(tool);
  }

  const gate = new ApprovalGate({ timeoutMs: options.approvalTimeoutMs ?? 10 * 60_000 });
  const loop = new AgentLoop(gateway, tools, { maxSteps: options.maxSteps ?? 6 });

  const timers = new Set<ReturnType<typeof setInterval>>();
  const controllers = new Map<string, AbortController>();
  const canceled = new Set<string>();

  app.get('/health', async () => ({
    ok: true,
    service: 'rakko-api',
    version: '0.2.0',
    provider: gateway.providerId,
    models: gateway.models,
    breakers: { standard: gateway.breakerState('standard'), fast: gateway.breakerState('fast') },
    store: store.kind,
    workspace,
    tools: tools.list().map((tool) => ({ name: tool.name, risk: tool.risk, approval: tool.requiresApproval })),
    pendingApprovals: gate.size,
  }));

  /** 界面是自包含单文件，直接由服务端吐出，同源就没有跨域问题 */
  const webFile = new URL('../../web/index.html', import.meta.url);
  let webCache: string | null = null;
  app.get('/', async (_request, reply) => {
    try {
      if (!webCache) webCache = await readFile(webFile, 'utf8');
      return reply.type('text/html; charset=utf-8').send(webCache);
    } catch {
      return reply.code(404).send({ error: 'web_missing', message: '界面文件 apps/web/index.html 不在' });
    }
  });

  app.get('/v1/usage', async () => store.usage());

  app.get('/v1/threads', async () => ({ items: await store.listThreads() }));

  app.post('/v1/threads', async (request, reply) => {
    const parsed = createThreadInput.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error.issues));
    return reply.code(201).send(await store.createThread(parsed.data.title));
  });

  app.get('/v1/threads/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await store.getThread(id))) return reply.code(404).send({ error: 'thread_not_found', message: '会话不存在' });
    return { items: await store.listMessages(id) };
  });

  app.get('/v1/runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await store.getRun(id);
    if (!run) return reply.code(404).send({ error: 'run_not_found', message: '运行不存在' });
    return { ...run, pendingApprovals: gate.list(id) };
  });

  app.post('/v1/runs', async (request, reply) => {
    const parsed = createRunInput.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error.issues));

    const thread = await store.getThread(parsed.data.threadId);
    if (!thread) return reply.code(404).send({ error: 'thread_not_found', message: '会话不存在' });

    const decision = await store.quotaDecision();
    if (decision.kind === 'block') {
      return reply.code(429).send({ error: 'quota_exceeded', message: decision.reason });
    }

    // 配额层面已经超了，就直接从快模型起跑，别先撞一次主模型
    const tier: ModelTier = decision.kind === 'degrade' ? 'fast' : 'standard';
    const run = await store.createRun({ threadId: thread.id, prompt: parsed.data.prompt, model: gateway.models[tier] });
    await store.appendMessage({ threadId: thread.id, role: 'user', text: parsed.data.prompt, runId: run.id });

    void drive(run, tier, decision.kind === 'degrade' ? decision.reason : null);

    return reply.code(202).send({ ...run, tier, degraded: tier === 'fast' });
  });

  /** 人在界面上点「允许 / 拒绝」。只能二选一，不允许改参数。 */
  app.post('/v1/runs/:id/approvals/:callId', async (request, reply) => {
    const { id, callId } = request.params as { id: string; callId: string };
    const parsed = approvalDecisionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error.issues));

    const decided = gate.decide(id, callId, {
      decision: parsed.data.decision,
      ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
    });
    if (!decided) {
      return reply.code(409).send({
        error: 'approval_gone',
        message: '这条审批已经不在了 —— 可能已超时、已处理，或运行已结束',
      });
    }
    return { ok: true, callId, decision: parsed.data.decision };
  });

  app.post('/v1/runs/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await store.getRun(id);
    if (!run) return reply.code(404).send({ error: 'run_not_found', message: '运行不存在' });
    if (['succeeded', 'failed', 'canceled'].includes(run.state)) {
      return reply.code(409).send({ error: 'already_finished', message: '这次运行已经结束了' });
    }

    canceled.add(id);
    const waiting = gate.cancelRun(id, '运行已取消，审批作废');
    controllers.get(id)?.abort();
    return { ok: true, releasedApprovals: waiting };
  });

  app.get('/v1/runs/:id/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!(await store.getRun(id))) return reply.code(404).send({ error: 'run_not_found', message: '运行不存在' });

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    let seq = 0;
    const write = (event: RunEvent): void => {
      seq += 1;
      reply.raw.write(`id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    for (const event of await store.eventsOf(id)) write(event);
    const unsubscribe = store.subscribe(id, write);

    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    timers.add(heartbeat);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      timers.delete(heartbeat);
      unsubscribe();
    });

    return reply;
  });

  async function drive(run: Run, tier: ModelTier, notice: string | null): Promise<void> {
    const at = (): string => new Date().toISOString();
    const emit = (event: RunEvent): Promise<void> => store.publish(event);
    const controller = new AbortController();
    controllers.set(run.id, controller);

    const finish = async (state: RunState, error?: string): Promise<void> => {
      await store.patchRun(run.id, { state, finishedAt: at(), ...(error ? { error } : {}) });
      await emit({ type: 'run.state', runId: run.id, at: at(), state });
      await emit({ type: 'run.done', runId: run.id, at: at(), state });
    };

    try {
      await store.patchRun(run.id, { state: 'running' });
      await emit({ type: 'run.started', runId: run.id, at: at() });
      await emit({ type: 'run.state', runId: run.id, at: at(), state: 'running' });
      if (notice) await emit({ type: 'run.delta', runId: run.id, at: at(), text: `（${notice}）\n` });

      const outcome = await loop.run(
        {
          runId: run.id,
          tier,
          messages: [{ role: 'user', content: run.prompt }],
          signal: controller.signal,
        },
        {
          onChunk: async (chunk) => {
            if (chunk.kind === 'delta') {
              await emit({ type: 'run.delta', runId: run.id, at: at(), text: chunk.text });
            } else if (chunk.kind === 'reasoning') {
              await emit({ type: 'run.reasoning', runId: run.id, at: at(), text: chunk.text });
            } else if (chunk.kind === 'fallback') {
              await store.patchRun(run.id, { model: gateway.models[chunk.to] });
              await emit({
                type: 'run.fallback',
                runId: run.id,
                at: at(),
                from: chunk.from,
                to: chunk.to,
                reason: chunk.reason,
              });
              await emit({ type: 'run.delta', runId: run.id, at: at(), text: `（${chunk.reason}）\n` });
            }
          },

          onToolCall: async (call) => {
            await emit({
              type: 'run.tool_call',
              runId: run.id,
              at: at(),
              callId: call.id,
              name: call.name,
              args: call.args,
            });
          },

          onToolResult: async (call, result) => {
            await emit({
              type: 'run.tool_result',
              runId: run.id,
              at: at(),
              callId: call.id,
              ok: result.ok,
              output: result.output,
            });
          },

          approve: async (call, tool) => {
            await store.patchRun(run.id, { state: 'waiting_approval' });
            await emit({
              type: 'run.approval_requested',
              runId: run.id,
              at: at(),
              callId: call.id,
              name: call.name,
              risk: tool.risk,
              args: call.args,
            });

            const decision = await gate.request({
              runId: run.id,
              callId: call.id,
              name: call.name,
              risk: tool.risk,
              args: call.args,
            });

            await emit({
              type: 'run.approval_decided',
              runId: run.id,
              at: at(),
              callId: call.id,
              decision: decision.decision,
              ...(decision.reason ? { reason: decision.reason } : {}),
            });

            if (!canceled.has(run.id)) await store.patchRun(run.id, { state: 'running' });
            return decision.decision;
          },
        },
      );

      if (canceled.has(run.id)) {
        await finish('canceled');
        return;
      }
      if (outcome.stopped === 'max_steps') {
        await emit({
          type: 'run.delta',
          runId: run.id,
          at: at(),
          text: `（到步数上限 ${outcome.steps} 先停一下，等你发下一步指令）\n`,
        });
      }

      await store.appendMessage({ threadId: run.threadId, role: 'assistant', text: outcome.text, runId: run.id });
      await store.chargeRun(run);
      await finish('succeeded');
    } catch (error) {
      if (canceled.has(run.id) || controller.signal.aborted) {
        await finish('canceled');
        return;
      }
      const message = error instanceof Error ? error.message : '未知错误';
      await emit({ type: 'run.error', runId: run.id, at: at(), message });
      await finish('failed', message);
    } finally {
      controllers.delete(run.id);
      canceled.delete(run.id);
    }
  }

  app.addHook('onClose', async () => {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    gate.cancelAll();
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
  });

  return app;
}
