import Fastify, { type FastifyInstance } from 'fastify';

import { FakeProvider, ProviderGateway, type ModelTier, type ModelProvider } from '@rakko/core';
import { createRunInput, createThreadInput, type Run, type RunEvent } from '@rakko/protocol';

import { MemoryStore, type RunStore } from './store.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const invalid = (issues: unknown[]) => ({ error: 'invalid_request', message: '请求体不合法', issues });

export const FAKE_MODELS: Record<ModelTier, string> = { standard: 'fake-standard', fast: 'fake-fast' };

export interface AppOptions {
  store?: RunStore;
  gateway?: ProviderGateway;
  /** 没给 gateway 时的便捷入口，默认假 provider */
  provider?: ModelProvider;
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
  const timers = new Set<ReturnType<typeof setInterval>>();

  app.get('/health', async () => ({
    ok: true,
    service: 'rakko-api',
    version: '0.1.0',
    provider: gateway.providerId,
    models: gateway.models,
    breakers: { standard: gateway.breakerState('standard'), fast: gateway.breakerState('fast') },
    store: store.kind,
  }));

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
    return run;
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

    try {
      await store.patchRun(run.id, { state: 'running' });
      await emit({ type: 'run.started', runId: run.id, at: at() });
      await emit({ type: 'run.state', runId: run.id, at: at(), state: 'running' });
      if (notice) await emit({ type: 'run.delta', runId: run.id, at: at(), text: `（${notice}）\n` });

      let text = '';
      for await (const chunk of gateway.stream({ runId: run.id, prompt: run.prompt, tier })) {
        if (chunk.kind === 'delta') {
          text += chunk.text;
          await emit({ type: 'run.delta', runId: run.id, at: at(), text: chunk.text });
        } else if (chunk.kind === 'reasoning') {
          await emit({ type: 'run.reasoning', runId: run.id, at: at(), text: chunk.text });
        } else if (chunk.kind === 'fallback') {
          await store.patchRun(run.id, { model: gateway.models[chunk.to] });
          await emit({ type: 'run.fallback', runId: run.id, at: at(), from: chunk.from, to: chunk.to, reason: chunk.reason });
          await emit({ type: 'run.delta', runId: run.id, at: at(), text: `（${chunk.reason}）\n` });
        } else if (chunk.kind === 'tool_call') {
          await emit({
            type: 'run.tool_call',
            runId: run.id,
            at: at(),
            callId: chunk.callId,
            name: chunk.name,
            args: chunk.args,
          });
        }
      }

      await store.appendMessage({ threadId: run.threadId, role: 'assistant', text, runId: run.id });
      await store.chargeRun(run);
      await store.patchRun(run.id, { state: 'succeeded', finishedAt: at() });
      await emit({ type: 'run.state', runId: run.id, at: at(), state: 'succeeded' });
      await emit({ type: 'run.done', runId: run.id, at: at(), state: 'succeeded' });
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      await store.patchRun(run.id, { state: 'failed', error: message, finishedAt: at() });
      await emit({ type: 'run.error', runId: run.id, at: at(), message });
      await emit({ type: 'run.done', runId: run.id, at: at(), state: 'failed' });
    }

    // 假 provider 也需要一点节奏，否则 SSE 一次性推完看不出流式
    await sleep(0);
  }

  app.addHook('onClose', async () => {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
  });

  return app;
}
