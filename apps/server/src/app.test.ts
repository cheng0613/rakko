import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createBuiltinTools, ProviderGateway, ToolRegistry } from '@rakko/core';
import type { ModelProvider, ProviderChunk, ProviderRequest } from '@rakko/core';

import { createApp, FAKE_MODELS, type AppOptions } from './app.js';
import { MemoryStore } from './store.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 读一段 SSE（到点就断开），用来验证续传 */
const readSse = async (
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 600,
): Promise<Array<{ type: string }>> => {
  const events: Array<{ type: string }> = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const reader = response.body?.getReader();
    if (!reader) return events;
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\n\n/);
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.split(/\n/).find((row) => row.startsWith('data: '));
        if (line) events.push(JSON.parse(line.slice(6)) as { type: string });
      }
    }
  } catch {
    /* 到点断开属正常 */
  } finally {
    clearTimeout(timer);
  }
  return events;
};

/** 默认给一个空工具表：不传工具时假 provider 就只回答、不调工具 */
const makeApp = (options: AppOptions = {}) =>
  createApp({ tools: new ToolRegistry({ workspace: process.cwd() }), ...options });

const waitFor = async (
  app: ReturnType<typeof createApp>,
  runId: string,
  predicate: (body: { state: string; pendingApprovals?: unknown[] }) => boolean,
  timeoutMs = 4_000,
): Promise<{ state: string; pendingApprovals?: unknown[] }> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = (await app.inject({ method: 'GET', url: `/v1/runs/${runId}` })).json();
    if (predicate(body)) return body;
    if (Date.now() > deadline) throw new Error(`等状态超时，当前是 ${body.state}`);
    await sleep(10);
  }
};

/** 先请求 write_file，拿到工具结果后再给结论 */
class WriteProvider implements ModelProvider {
  readonly id = 'write';

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    if (!request.messages.some((message) => message.role === 'tool')) {
      yield { kind: 'tool_call', callId: 'call_write', name: 'write_file', args: { path: 'note.txt', content: '批准了' } };
      yield { kind: 'done', finishReason: 'tool_use' };
      return;
    }
    yield { kind: 'delta', text: '写好了。' };
    yield { kind: 'done', finishReason: 'stop' };
  }
}

const approvalApp = async (approvalTimeoutMs?: number) => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'rakko-api-'));
  const tools = new ToolRegistry({ workspace });
  for (const tool of createBuiltinTools({ workspace })) tools.register(tool);
  const gateway = new ProviderGateway({ provider: new WriteProvider(), models: FAKE_MODELS, firstChunkTimeoutMs: 2_000 });
  const store = new MemoryStore();
  const app = createApp({ store, gateway, tools, workspace, ...(approvalTimeoutMs ? { approvalTimeoutMs } : {}) });
  return { app, workspace, store };
};

const startRun = async (app: ReturnType<typeof createApp>): Promise<string> => {
  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();
  const run = (await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: thread.id, prompt: '写个文件' } })).json();
  return run.id as string;
};

test('健康检查带上 provider、模型、工具与工作区', async () => {
  const app = makeApp();
  const body = (await app.inject({ method: 'GET', url: '/health' })).json();

  assert.equal(body.ok, true);
  assert.equal(body.service, 'rakko-api');
  assert.equal(body.store, 'memory');
  assert.equal(body.models.standard, 'fake-standard');
  assert.equal(body.pendingApprovals, 0);
  await app.close();
});

test('建会话返回 201，并能在列表里查到', async () => {
  const app = makeApp();
  const created = await app.inject({ method: 'POST', url: '/v1/threads', payload: { title: '迁移 schema' } });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().title, '迁移 schema');

  const list = await app.inject({ method: 'GET', url: '/v1/threads' });
  assert.equal(list.json().items.length, 1);
  await app.close();
});

test('运行请求缺提示词时返回 400 而不是 500', async () => {
  const app = makeApp();
  const response = await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: 'missing', prompt: '' } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'invalid_request');
  await app.close();
});

test('会话不存在时返回 404，并给中文说明', async () => {
  const app = makeApp();
  const response = await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: 'nope', prompt: '看看构建' } });
  assert.equal(response.statusCode, 404);
  assert.match(response.json().message, /会话不存在/);
  await app.close();
});

test('配额用完后按设置降级：从快档起跑，不先撞主模型', async () => {
  const store = new MemoryStore();
  store.setUsage(120);
  const app = makeApp({ store });

  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();
  const run = (
    await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: thread.id, prompt: '跑一下测试' } })
  ).json();

  assert.equal(run.degraded, true);
  assert.equal(run.tier, 'fast');
  assert.equal(run.model, 'fake-fast');
  await app.close();
});

test('思考流单独落事件，回答只由 delta 拼成', async () => {
  const store = new MemoryStore();
  const app = makeApp({ store });

  const runId = await startRun(app);
  await waitFor(app, runId, (body) => body.state === 'succeeded');

  const types = (await store.eventsOf(runId)).map((event) => event.type);
  assert.ok(types.includes('run.reasoning'), '思考过程应该有自己的事件');

  const messages = await store.listMessages((await store.getRun(runId))!.threadId);
  const assistant = messages.find((message) => message.role === 'assistant');
  assert.ok(assistant);
  assert.doesNotMatch(assistant.text, /先看现状/, '思考内容不能拼进回答');
  await app.close();
});

test('审批允许：先挂起等待，点允许后才执行并落盘', async () => {
  const { app, workspace, store } = await approvalApp();
  const runId = await startRun(app);

  const paused = await waitFor(app, runId, (body) => body.state === 'waiting_approval');
  assert.equal(paused.state, 'waiting_approval');
  assert.equal(paused.pendingApprovals?.length, 1);

  const pending = paused.pendingApprovals?.[0] as { callId: string; name: string; risk: string };
  assert.equal(pending.name, 'write_file');
  assert.equal(pending.risk, 'high');

  const decided = await app.inject({
    method: 'POST',
    url: `/v1/runs/${runId}/approvals/${pending.callId}`,
    payload: { decision: 'allow' },
  });
  assert.equal(decided.statusCode, 200);

  await waitFor(app, runId, (body) => body.state === 'succeeded');
  assert.equal(await readFile(path.join(workspace, 'note.txt'), 'utf8'), '批准了');

  const types = (await store.eventsOf(runId)).map((event) => event.type);
  assert.ok(types.includes('run.approval_requested'));
  assert.ok(types.includes('run.approval_decided'));
  assert.ok(types.includes('run.tool_result'));
  assert.ok(types.indexOf('run.approval_requested') < types.indexOf('run.tool_result'), '审批在前，执行在后');
  await app.close();
});

test('审批拒绝：不落盘，运行照样收尾为 succeeded', async () => {
  const { app, workspace } = await approvalApp();
  const runId = await startRun(app);

  const paused = await waitFor(app, runId, (body) => body.state === 'waiting_approval');
  const pending = paused.pendingApprovals?.[0] as { callId: string };

  await app.inject({
    method: 'POST',
    url: `/v1/runs/${runId}/approvals/${pending.callId}`,
    payload: { decision: 'deny', reason: '不想写文件' },
  });

  await waitFor(app, runId, (body) => body.state === 'succeeded');
  assert.equal(existsSync(path.join(workspace, 'note.txt')), false);
  await app.close();
});

test('没人审批就自动拒绝，运行不会烂在 waiting_approval', async () => {
  const { app, workspace } = await approvalApp(60);
  const runId = await startRun(app);

  await waitFor(app, runId, (body) => body.state === 'succeeded', 6_000);
  assert.equal(existsSync(path.join(workspace, 'note.txt')), false);
  await app.close();
});

test('重复审批返回 409，而不是假装成功', async () => {
  const { app } = await approvalApp();
  const runId = await startRun(app);
  const paused = await waitFor(app, runId, (body) => body.state === 'waiting_approval');
  const callId = (paused.pendingApprovals?.[0] as { callId: string }).callId;

  const first = await app.inject({ method: 'POST', url: `/v1/runs/${runId}/approvals/${callId}`, payload: { decision: 'allow' } });
  assert.equal(first.statusCode, 200);

  const second = await app.inject({ method: 'POST', url: `/v1/runs/${runId}/approvals/${callId}`, payload: { decision: 'allow' } });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, 'approval_gone');
  await app.close();
});

test('卡在审批时取消运行：状态变 canceled，审批一并作废', async () => {
  const { app } = await approvalApp();
  const runId = await startRun(app);
  await waitFor(app, runId, (body) => body.state === 'waiting_approval');

  const canceled = await app.inject({ method: 'POST', url: `/v1/runs/${runId}/cancel` });
  assert.equal(canceled.statusCode, 200);
  assert.equal(canceled.json().releasedApprovals, 1);

  const final = await waitFor(app, runId, (body) => body.state === 'canceled');
  assert.equal(final.state, 'canceled');
  assert.equal((final.pendingApprovals ?? []).length, 0);

  const again = await app.inject({ method: 'POST', url: `/v1/runs/${runId}/cancel` });
  assert.equal(again.statusCode, 409);
  await app.close();
});

test('界面由服务端自己吐出来，同源不用跨域', async () => {
  const app = makeApp();
  const response = await app.inject({ method: 'GET', url: '/' });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'] ?? '', /text\/html/);
  assert.match(response.body, /Rakko/);
  assert.match(response.body, /run\.approval_requested/, '界面要认得审批事件');
  assert.doesNotMatch(response.body, /src="\.\//, '单文件界面不应该引用同目录资源');
  await app.close();
});

test('一次运行把文字、工具、审批全落进 messages，重开会话才能重放', async () => {
  const { app, store } = await approvalApp();
  const runId = await startRun(app);

  const paused = await waitFor(app, runId, (body) => body.state === 'waiting_approval');
  const callId = (paused.pendingApprovals?.[0] as { callId: string }).callId;
  await app.inject({ method: 'POST', url: `/v1/runs/${runId}/approvals/${callId}`, payload: { decision: 'allow' } });
  await waitFor(app, runId, (body) => body.state === 'succeeded');

  const run = await store.getRun(runId);
  const items = await store.listMessages(run!.threadId);
  assert.deepEqual(
    items.map((item) => item.kind),
    ['text', 'tool_call', 'approval', 'approval_decision', 'tool_result', 'text'],
  );

  assert.equal(items[0]?.role, 'user');
  const toolCall = items.find((item) => item.kind === 'tool_call');
  assert.equal(toolCall?.payload?.name, 'write_file');
  assert.deepEqual(toolCall?.payload?.args, { path: 'note.txt', content: '批准了' });

  const decision = items.find((item) => item.kind === 'approval_decision');
  assert.equal(decision?.payload?.decision, 'allow');

  const result = items.find((item) => item.kind === 'tool_result');
  assert.equal(result?.payload?.ok, true);

  // 回答是分段落的，不是一整坨
  const texts = items.filter((item) => item.kind === 'text' && item.role === 'assistant');
  assert.equal(texts.length, 1);
  assert.match(texts[0]?.text ?? '', /写好了/);
  await app.close();
});

test('配额用超且不允许降级时直接拦下（429）', async () => {
  const store = new MemoryStore({ limit: 120, used: 120, degradeOnExceed: false });
  const app = makeApp({ store });

  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();
  const response = await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: thread.id, prompt: '还能跑吗' } });

  assert.equal(response.statusCode, 429);
  assert.equal(response.json().error, 'quota_exceeded');
  assert.match(response.json().message, /次数已用完/);
  await app.close();
});

test('内存实现默认从 0 次开始，不再假装已经用过 62 次', async () => {
  const store = new MemoryStore();
  const usage = await store.usage();
  assert.equal(usage.used, 0);
  assert.equal(usage.remaining, usage.limit);
});

test('SSE 带 Last-Event-ID 只补没看过的事件', async () => {
  const app = makeApp();
  const base = await app.listen({ port: 0, host: '127.0.0.1' });

  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();
  const run = (await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: thread.id, prompt: '跑一下' } })).json();
  for (let i = 0; i < 60; i += 1) {
    const body = (await app.inject({ method: 'GET', url: `/v1/runs/${run.id}` })).json();
    if (body.state === 'succeeded') break;
    await sleep(20);
  }

  const url = `${base}/v1/runs/${run.id}/events`;
  const all = await readSse(url, {}, 500);
  assert.ok(all.length >= 4, '至少要有 started/state/delta/done');

  const resumed = await readSse(url, { 'last-event-id': '3' }, 500);
  assert.equal(resumed.length, all.length - 3);
  assert.deepEqual(resumed.map((event) => event.type), all.slice(3).map((event) => event.type));
  await app.close();
});
