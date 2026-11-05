import Fastify, { type FastifyInstance } from 'fastify';

import { FakeProvider, type ModelProvider } from '@rakko/core';
import { createRunInput, createThreadInput, type Run, type RunEvent } from '@rakko/protocol';

import { Store } from './store.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const invalid = (issues: unknown[]) => ({ error: 'invalid_request', message: '请求体不合法', issues });

export interface AppOptions {
  provider?: ModelProvider;
  store?: Store;
}

export function createApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const store = options.store ?? new Store();
  const provider = options.provider ?? new FakeProvider();
  const timers = new Set<ReturnType<typeof setInterval>>();

  app.get('/health', async () => ({ ok: true, service: 'rakko-api', version: '0.1.0', provider: provider.id }));

  app.get('/v1/usage', async () => store.usage());

  app.get('/v1/threads', async () => ({ items: store.listThreads() }));

  app.post('/v1/threads', async (request, reply) => {
    const parsed = createThreadInput.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error.issues));
    return reply.code(201).send(store.createThread(parsed.data.title));
  });

  app.get('/v1/threads/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getThread(id)) return reply.code(404).send({ error: 'thread_not_found', message: '会话不存在' });
    return { items: store.listMessages(id) };
  });

  app.get('/v1/runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = store.getRun(id);
    if (!run) return reply.code(404).send({ error: 'run_not_found', message: '运行不存在' });
    return run;
  });

  app.post('/v1/runs', async (request, reply) => {
    const parsed = createRunInput.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error.issues));

    const thread = store.getThread(parsed.data.threadId);
    if (!thread) return reply.code(404).send({ error: 'thread_not_found', message: '会话不存在' });

    const decision = store.quotaDecision();
    if (decision.kind === 'block') {
      return reply.code(429).send({ error: 'quota_exceeded', message: decision.reason });
    }

    const degraded = decision.kind === 'degrade';
    const model = degraded ? 'fast' : (parsed.data.model ?? 'standard');
    const run = store.createRun({ threadId: thread.id, prompt: parsed.data.prompt, model });
    store.appendMessage({ threadId: thread.id, role: 'user', text: parsed.data.prompt, runId: run.id });

    void drive(run, degraded ? decision.reason : null);

    return reply.code(202).send({ ...run, degraded });
  });

  app.get('/v1/runs/:id/events', (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getRun(id)) return reply.code(404).send({ error: 'run_not_found', message: '运行不存在' });

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

    for (const event of store.eventsOf(id)) write(event);
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

  async function drive(run: Run, notice: string | null): Promise<void> {
    const at = (): string => new Date().toISOString();
    const emit = (event: RunEvent): void => store.publish(event);

    try {
      store.patchRun(run.id, { state: 'running' });
      emit({ type: 'run.started', runId: run.id, at: at() });
      emit({ type: 'run.state', runId: run.id, at: at(), state: 'running' });
      if (notice) emit({ type: 'run.delta', runId: run.id, at: at(), text: `（${notice}）\n` });

      let text = '';
      for await (const chunk of provider.stream({ runId: run.id, prompt: run.prompt, model: run.model })) {
        if (chunk.kind === 'delta') {
          text += chunk.text;
          emit({ type: 'run.delta', runId: run.id, at: at(), text: chunk.text });
        } else if (chunk.kind === 'tool_call') {
          emit({
            type: 'run.tool_call',
            runId: run.id,
            at: at(),
            callId: chunk.callId,
            name: chunk.name,
            args: chunk.args,
          });
        }
        await sleep(5);
      }

      store.appendMessage({ threadId: run.threadId, role: 'assistant', text, runId: run.id });
      store.chargeRun();
      store.patchRun(run.id, { state: 'succeeded', finishedAt: at() });
      emit({ type: 'run.state', runId: run.id, at: at(), state: 'succeeded' });
      emit({ type: 'run.done', runId: run.id, at: at(), state: 'succeeded' });
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      store.patchRun(run.id, { state: 'failed', error: message, finishedAt: at() });
      emit({ type: 'run.error', runId: run.id, at: at(), message });
      emit({ type: 'run.done', runId: run.id, at: at(), state: 'failed' });
    }
  }

  app.addHook('onClose', async () => {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
  });

  return app;
}
