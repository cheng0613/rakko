import { readFile } from 'node:fs/promises';
import path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';

import {
  AgentLoop,
  ApprovalGate,
  createBuiltinTools,
  FakeProvider,
  ProviderGateway,
  ToolRegistry,
  type AgentHooks,
  type ChatMessage,
  type ModelProvider,
  type ModelTier,
} from '@rakko/core';
import {
  approvalDecisionSchema,
  createRunInput,
  createThreadInput,
  updateSettingsInput,
  type Message,
  type Run,
  type RunEvent,
  type RunState,
} from '@rakko/protocol';

import { MemoryStore, type PendingCall, type RunStore } from './store.js';

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
  /** 用户点过「允许这类」的工具；启动时从设置里读回来 */
  const grants = new Set<string>();
  const loop = new AgentLoop(gateway, tools, { maxSteps: options.maxSteps ?? 12 });

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

  /**
   * 界面是自包含单文件，由服务端直接吐出，同源就没有跨域问题。
   * 不缓存：改完 HTML 刷新就能看到，不用重启（M0 阶段这比省一次读盘重要）。
   */
  // 打包后界面不在 ../web，用 RAKKO_WEB_DIR 指过去
  const webFile = process.env.RAKKO_WEB_DIR
    ? path.join(process.env.RAKKO_WEB_DIR, 'index.html')
    : new URL('../../web/index.html', import.meta.url);
  app.get('/', async (_request, reply) => {
    try {
      const html = await readFile(webFile, 'utf8');
      return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
    } catch {
      return reply.code(404).send({ error: 'web_missing', message: '界面文件 apps/web/index.html 不在' });
    }
  });

  app.get('/v1/usage', async () => store.usage());

  app.get('/v1/settings', async () => store.getSettings());

  app.patch('/v1/settings', async (request, reply) => {
    const parsed = updateSettingsInput.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error.issues));
    if (Object.keys(parsed.data).length === 0) {
      return reply.code(400).send({ error: 'invalid_request', message: '没有要改的设置项' });
    }
    return store.updateSettings(parsed.data);
  });

  app.get('/v1/threads', async () => ({ items: await store.listThreads() }));

  app.post('/v1/threads', async (request, reply) => {
    const parsed = createThreadInput.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error.issues));
    return reply.code(201).send(await store.createThread(parsed.data.title));
  });

  app.get('/v1/threads/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const thread = await store.getThread(id);
    if (!thread) return reply.code(404).send({ error: 'thread_not_found', message: '会话不存在' });
    const latestRun = (await store.latestRunForThread(id)) ?? null;
    return { thread, latestRun, pendingApprovals: latestRun ? gate.list(latestRun.id) : [] };
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
      ...(parsed.data.scope ? { scope: parsed.data.scope } : {}),
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

    // 事件 id = 该运行的第几条事件（从 1 起），断线重连靠 Last-Event-ID 只补没看过的
    const lastSeen = Number(request.headers['last-event-id'] ?? 0) || 0;
    const write = (event: RunEvent, seq: number): void => {
      reply.raw.write(`id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    reply.raw.write('retry: 3000\n\n');
    const replay = await store.eventsOf(id);
    for (const [index, event] of replay.entries()) {
      if (index + 1 > lastSeen) write(event, index + 1);
    }

    let seq = replay.length;
    const unsubscribe = store.subscribe(id, (event) => {
      seq += 1;
      write(event, seq);
    });

    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    timers.add(heartbeat);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      timers.delete(heartbeat);
      unsubscribe();
    });

    return reply;
  });


  /** 系统提示：把环境事实与干活纪律一次说清，别让模型拿 Linux 路径套 Windows */
  function buildSystemPrompt(): string {
    const platformHint =
      process.platform === 'win32'
        ? 'Windows（shell 走 cmd；路径写盘符路径或相对路径，不要用 /home/xxx 这种）'
        : process.platform === 'darwin'
          ? 'macOS（shell 走 /bin/sh）'
          : 'Linux（shell 走 /bin/sh）';

    return [
      '你是 Rakko，跑在用户自己电脑上的个人 agent。用户给的是任务，不是闲聊。',
      '',
      '## 运行环境',
      `- 系统：${platformHint}`,
      `- 工作区：${workspace}`,
      '- 文件工具的路径都相对工作区，越界会被拒。',
      '- shell 的工作目录就是工作区，命令直接跑，不要再 cd 到别处。',
      '',
      '## 工具',
      '- read_file / list_dir / grep：只读，直接执行。改文件前先读一遍。',
      '- apply_patch：old 必须在文件里唯一命中，0 次或多次都会失败；失败后补上下文再试。',
      '- write_file：整文件覆盖，仅在新建文件时用。',
      '- shell：跑测试、构建、看命令输出。',
      '- http：发请求，默认不许打内网。',
      '高风险工具会停下来等用户审批；用户点过「允许这类」后不再问。',
      '',
      '## 干活纪律',
      '1. 先看清现状再动手：读文件、grep 确认位置，再改。',
      '2. 改完必须验证：跑相关测试或命令；失败就读输出找原因再改，不要靠猜。',
      '3. 没验证就不要说「完成了」。做不到就直说卡在哪一步。',
      '4. 不要假装执行过工具：只有工具结果里出现的东西才算做过。',
      '5. 探索要克制：一次 grep + 一两次 read 就该动手；连续三个只读步骤还没改动，说明该改了。',
      '',
      '## 回答',
      '- 用中文，简洁，先说结论。代码、命令、路径、标识符保持原样。',
    ].join('\n');
  }

  /** 把落库的消息还原成模型能读的历史（tool 消息必须带 toolCallId） */
  function buildHistory(items: Message[]): ChatMessage[] {
    const history: ChatMessage[] = [];
    for (const item of items) {
      const payload = item.payload ?? {};
      if (item.kind === 'text' && item.role === 'user') {
        history.push({ role: 'user', content: item.text });
      } else if (item.kind === 'text' && item.role === 'assistant') {
        history.push({ role: 'assistant', content: item.text });
      } else if (item.kind === 'tool_call') {
        const call = {
          id: String(payload.callId ?? ''),
          name: String(payload.name ?? ''),
          args: (payload.args as Record<string, unknown>) ?? {},
        };
        const last = history.at(-1);
        if (last && last.role === 'assistant' && last.toolCalls) last.toolCalls.push(call);
        else history.push({ role: 'assistant', content: '', toolCalls: [call] });
      } else if (item.kind === 'tool_result') {
        history.push({
          role: 'tool',
          toolCallId: String(payload.callId ?? ''),
          name: String(payload.name ?? ''),
          content: JSON.stringify({ ok: payload.ok, output: payload.output }),
        });
      }
      // approval / approval_decision / notice 不是模型上下文
    }
    return history;
  }

  /**
   * 一次运行的实际执行：流、工具、审批、落库都在这里。
   * drive() 从一句新指令开始；resumeRun() 从库里的历史 + 一个还挂着的审批继续。
   */
  async function executeRun(
    run: Run,
    tier: ModelTier,
    messages: ChatMessage[],
    pending: PendingCall | null,
    notice: string | null,
  ): Promise<void> {
    const at = (): string => new Date().toISOString();
    const emit = (event: RunEvent): Promise<void> => store.publish(event);
    const controller = new AbortController();
    controllers.set(run.id, controller);

    const finish = async (state: RunState, error?: string): Promise<void> => {
      await flushSegment();
      // 成功/取消都要把 error 清空：否则中途被误标过错的运行会一直挂着旧错误
      await store.patchRun(run.id, { state, finishedAt: at(), error: error ?? null });
      await emit({ type: 'run.state', runId: run.id, at: at(), state });
      await emit({ type: 'run.done', runId: run.id, at: at(), state });
    };

    /**
     * 助手文字是分成「段」落库的：遇到工具卡、审批、提示就封口。
     * 这样重开会话时，卡片还能待在该待的位置；失败时也不会丢掉已经说出口的话。
     */
    let segment = '';
    const flushSegment = async (): Promise<void> => {
      const text = segment;
      segment = '';
      if (!text.trim()) return;
      await store.appendMessage({ threadId: run.threadId, role: 'assistant', kind: 'text', text, runId: run.id });
    };
    const record = async (
      kind: 'tool_call' | 'tool_result' | 'approval' | 'approval_decision' | 'notice',
      role: 'assistant' | 'tool' | 'system',
      payload: Record<string, unknown>,
      text = '',
    ): Promise<void> => {
      await store.appendMessage({ threadId: run.threadId, role, kind, text, payload, runId: run.id });
    };

    const hooks: AgentHooks = {
      onChunk: async (chunk) => {
        if (chunk.kind === 'delta') {
          segment += chunk.text;
          await emit({ type: 'run.delta', runId: run.id, at: at(), text: chunk.text });
        } else if (chunk.kind === 'reasoning') {
          await emit({ type: 'run.reasoning', runId: run.id, at: at(), text: chunk.text });
        } else if (chunk.kind === 'fallback') {
          await store.patchRun(run.id, { model: gateway.models[chunk.to] });
          await flushSegment();
          await record(
            'notice',
            'system',
            { reason: 'fallback', detail: chunk.reason, from: chunk.from, to: chunk.to },
            chunk.reason,
          );
          await emit({
            type: 'run.fallback',
            runId: run.id,
            at: at(),
            from: chunk.from,
            to: chunk.to,
            reason: chunk.reason,
          });
        }
      },

      onToolCall: async (call) => {
        await flushSegment();
        await record('tool_call', 'assistant', { callId: call.id, name: call.name, args: call.args });
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
        await record('tool_result', 'tool', {
          callId: call.id,
          name: call.name,
          ok: result.ok,
          output: result.output,
          durationMs: result.durationMs,
        });
        await emit({
          type: 'run.tool_result',
          runId: run.id,
          at: at(),
          callId: call.id,
          ok: result.ok,
          output: result.output,
        });
      },

      isGranted: (toolName: string): boolean => grants.has(toolName),

      approve: async (call, tool) => {
        await flushSegment();
        await store.patchRun(run.id, { state: 'waiting_approval' });
        await record('approval', 'system', {
          callId: call.id,
          name: call.name,
          risk: tool.risk,
          args: call.args,
        });
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

        await record('approval_decision', 'system', {
          callId: call.id,
          decision: decision.decision,
          ...(decision.reason ? { reason: decision.reason } : {}),
        });
        await emit({
          type: 'run.approval_decided',
          runId: run.id,
          at: at(),
          callId: call.id,
          decision: decision.decision,
          ...(decision.reason ? { reason: decision.reason } : {}),
        });

        // 「允许这类」：记进设置，之后这个工具不再问
        if (decision.decision === 'allow' && decision.scope === 'always') {
          grants.add(call.name);
          await store.updateSettings({ approvedTools: [...grants] });
          await record('notice', 'system', { reason: 'grant', tool: call.name }, `已允许「${call.name}」这类调用，之后不再询问`);
        }

        if (!canceled.has(run.id)) await store.patchRun(run.id, { state: 'running' });
        return { decision: decision.decision, ...(decision.scope ? { scope: decision.scope } : {}) };
      },
    };

    try {
      if (notice) {
        await record('notice', 'system', { reason: 'quota', detail: notice, from: 'standard', to: 'fast' }, notice);
        await emit({ type: 'run.fallback', runId: run.id, at: at(), from: 'standard', to: 'fast', reason: notice });
      }

      if (pending) {
        // 重启后接着等同一个审批：不重新发 approval_requested，历史里已经有了
        const decision = await gate.request({
          runId: run.id,
          callId: pending.callId,
          name: pending.name,
          risk: pending.risk,
          args: pending.args,
        });
        await record('approval_decision', 'system', {
          callId: pending.callId,
          decision: decision.decision,
          ...(decision.reason ? { reason: decision.reason } : {}),
        });
        await emit({
          type: 'run.approval_decided',
          runId: run.id,
          at: at(),
          callId: pending.callId,
          decision: decision.decision,
          ...(decision.reason ? { reason: decision.reason } : {}),
        });

        const tool = tools.get(pending.name);
        await store.patchRun(run.id, { state: 'running' });
        if (decision.decision === 'allow' && decision.scope === 'always') {
          grants.add(pending.name);
          await store.updateSettings({ approvedTools: [...grants] });
        }

        const result = tool
          ? await tools.execute(
              { id: pending.callId, name: pending.name, args: pending.args },
              {
                approve: async () => ({ decision: decision.decision, ...(decision.scope ? { scope: decision.scope } : {}) }),
                isGranted: (toolName: string) => grants.has(toolName),
              },
            )
          : { ok: false, output: `没有名为 ${pending.name} 的工具`, durationMs: 0 };

        await record('tool_result', 'tool', {
          callId: pending.callId,
          name: pending.name,
          ok: result.ok,
          output: result.output,
          durationMs: result.durationMs,
        });
        await emit({
          type: 'run.tool_result',
          runId: run.id,
          at: at(),
          callId: pending.callId,
          ok: result.ok,
          output: result.output,
        });

        messages.push({
          role: 'tool',
          toolCallId: pending.callId,
          name: pending.name,
          content: JSON.stringify(result),
        });
      }

      const outcome = await loop.run({ runId: run.id, tier, messages, signal: controller.signal }, hooks);

      if (canceled.has(run.id)) {
        await finish('canceled');
        return;
      }
      if (outcome.stopped === 'max_steps') {
        const reason = `到步数上限（${outcome.steps} 轮）先停一下，任务没做完`;
        await emit({ type: 'run.delta', runId: run.id, at: at(), text: `（${reason}）\n` });
        await store.chargeRun(run);
        await finish('failed', reason);
        return;
      }

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

  async function drive(run: Run, tier: ModelTier, notice: string | null): Promise<void> {
    const at = (): string => new Date().toISOString();
    await store.patchRun(run.id, { state: 'running' });
    await store.publish({ type: 'run.started', runId: run.id, at: at() });
    await store.publish({ type: 'run.state', runId: run.id, at: at(), state: 'running' });
    await executeRun(run, tier, [{ role: 'system', content: buildSystemPrompt() }, { role: 'user', content: run.prompt }], null, notice);
  }

  /** 重启后恢复：拿库里的历史 + 还挂着的审批，接着跑 */
  async function resumeRun(run: Run, pending: PendingCall | null): Promise<void> {
    const items = await store.listMessages(run.threadId);
    const messages: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt() }, ...buildHistory(items)];
    const tier: ModelTier = run.model === gateway.models.fast ? 'fast' : 'standard';
    await executeRun(run, tier, messages, pending, null);
  }

  app.addHook('onReady', async () => {
    const settings = await store.getSettings();
    for (const name of settings.approvedTools) grants.add(name);

    const resumable = await store.resumableRuns();
    for (const item of resumable) {
      void resumeRun(item.run, item.pending).catch((error: unknown) => {
        console.error('恢复运行失败：', error);
      });
    }
    if (resumable.length > 0) console.log(`恢复 ${resumable.length} 个等待审批的运行`);
  });

  app.addHook('onClose', async () => {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    gate.cancelAll();
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
  });

  return app;
}
