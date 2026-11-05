import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDb, migrateDb } from '@rakko/db';
import { createBuiltinTools, createSecondToolset, PluginHost, ProviderGateway, ToolRegistry } from '@rakko/core';
import type { ModelProvider, ProviderChunk, ProviderRequest } from '@rakko/core';

import { createApp, FAKE_MODELS, type AppOptions } from './app.js';
import { PostgresStore } from './postgres-store.js';
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

test('线程详情带上最近一次运行，界面刷新后据此决定要不要接着看流', async () => {
  const store = new MemoryStore();
  const app = makeApp({ store });

  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();
  const detailBefore = (await app.inject({ method: 'GET', url: `/v1/threads/${thread.id}` })).json();
  assert.equal(detailBefore.latestRun, null);

  const run = (await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: thread.id, prompt: '跑一下' } })).json();
  const detail = (await app.inject({ method: 'GET', url: `/v1/threads/${thread.id}` })).json();
  assert.equal(detail.latestRun.id, run.id);
  assert.deepEqual(detail.pendingApprovals, []);
  await app.close();
});

test('重启后停在等待审批的运行能接着批，把工具跑完', { skip: !process.env.DATABASE_URL }, async () => {
  const handle = createDb(process.env.DATABASE_URL!, { max: 2 });
  await migrateDb(handle);

  const email = `resume-${Date.now()}@rakko.app`;
  const workspace = await mkdtemp(path.join(tmpdir(), 'rakko-resume-'));
  const tools = new ToolRegistry({ workspace });
  for (const tool of createBuiltinTools({ workspace })) tools.register(tool);

  // 1) 造出「上一个进程留下的现场」
  const store1 = new PostgresStore(handle, { email, plan: 'pro' });
  await store1.ready();
  const thread = await store1.createThread('重启验收');
  const run = await store1.createRun({ threadId: thread.id, prompt: '写个文件', model: 'fake-standard' });
  await store1.patchRun(run.id, { state: 'waiting_approval' });
  const args = { path: 'note.txt', content: '重启后写的' };
  await store1.appendMessage({ threadId: thread.id, role: 'user', kind: 'text', text: '写个文件', runId: run.id });
  await store1.appendMessage({
    threadId: thread.id, role: 'assistant', kind: 'tool_call',
    text: '', payload: { callId: 'call_resume', name: 'write_file', args }, runId: run.id,
  });
  await store1.appendMessage({
    threadId: thread.id, role: 'system', kind: 'approval',
    text: '', payload: { callId: 'call_resume', name: 'write_file', risk: 'high', args }, runId: run.id,
  });

  // 2) 换一个 store / app，模拟进程重启
  const store2 = new PostgresStore(handle, { email, plan: 'pro' });
  await store2.ready();
  const gateway = new ProviderGateway({ provider: new WriteProvider(), models: FAKE_MODELS, firstChunkTimeoutMs: 2000 });
  const app2 = createApp({ store: store2, gateway, tools, workspace, approvalTimeoutMs: 60_000 });
  await app2.ready();

  // 恢复是异步的（要先算工具策略），等审批挂上去再断言
  const resumed = await waitFor(
    app2,
    run.id,
    (body) => body.state === 'waiting_approval' && (body.pendingApprovals?.length ?? 0) > 0,
  );
  assert.equal(resumed.pendingApprovals?.length, 1);
  assert.equal((resumed.pendingApprovals?.[0] as { name: string }).name, 'write_file');

  const decided = await app2.inject({
    method: 'POST', url: `/v1/runs/${run.id}/approvals/call_resume`, payload: { decision: 'allow' },
  });
  assert.equal(decided.statusCode, 200);

  for (let i = 0; i < 200; i += 1) {
    const body = (await app2.inject({ method: 'GET', url: `/v1/runs/${run.id}` })).json();
    if (body.state === 'succeeded' || body.state === 'failed') break;
    await sleep(20);
  }

  const final = (await app2.inject({ method: 'GET', url: `/v1/runs/${run.id}` })).json();
  assert.equal(final.state, 'succeeded');
  assert.equal(await readFile(path.join(workspace, 'note.txt'), 'utf8'), '重启后写的');

  const items = await store2.listMessages(thread.id);
  assert.ok(items.some((item) => item.kind === 'approval_decision'), '审批结论要落库');
  assert.ok(items.some((item) => item.kind === 'tool_result' && item.payload?.ok === true), '工具结果要落库');

  await app2.close();
  await handle.sql`delete from users where email = ${email}`;
  await store2.close();
});

test('设置可读可改：用超了到底降级还是拦下，用户自己定', async () => {
  const store = new MemoryStore({ used: 120 });
  const app = makeApp({ store });

  const before = (await app.inject({ method: 'GET', url: '/v1/settings' })).json();
  assert.equal(before.degradeOnExceed, true);

  const patched = await app.inject({ method: 'PATCH', url: '/v1/settings', payload: { degradeOnExceed: false } });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().degradeOnExceed, false);

  // 配额已满 + 不降级 → 直接 429
  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();
  const blocked = await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: thread.id, prompt: '还能跑吗' } });
  assert.equal(blocked.statusCode, 429);

  const empty = await app.inject({ method: 'PATCH', url: '/v1/settings', payload: {} });
  assert.equal(empty.statusCode, 400);
  await app.close();
});

test('「允许这类」之后同名工具不再弹审批，而且记进设置', async () => {
  const { app, store } = await approvalApp();

  const runId = await startRun(app);
  const paused = await waitFor(app, runId, (body) => body.state === 'waiting_approval');
  const callId = (paused.pendingApprovals?.[0] as { callId: string }).callId;

  const decided = await app.inject({
    method: 'POST',
    url: `/v1/runs/${runId}/approvals/${callId}`,
    payload: { decision: 'allow', scope: 'always' },
  });
  assert.equal(decided.statusCode, 200);
  await waitFor(app, runId, (body) => body.state === 'succeeded');

  const settings = (await app.inject({ method: 'GET', url: '/v1/settings' })).json();
  assert.deepEqual(settings.approvedTools, ['write_file']);

  // 第二次跑同样的活：不该再停下来等人
  const second = await startRun(app);
  const secondBody = await waitFor(app, second, (body) => body.state === 'succeeded' || body.state === 'waiting_approval');
  assert.equal(secondBody.state, 'succeeded');

  const types = (await store.eventsOf(second)).map((event) => event.type);
  assert.ok(!types.includes('run.approval_requested'), '不该再弹审批');
  assert.ok(types.includes('run.tool_result'));
  await app.close();
});

test('同一会话接着聊：第二轮带上了上一轮的对话', async () => {
  const store = new MemoryStore();
  const calls: string[][] = [];

  const provider: ModelProvider = {
    id: 'recording',
    async *stream(request) {
      calls.push(request.messages.map((message) => `${message.role}:${message.content.slice(0, 12)}`));
      const last = request.messages.at(-1)?.content ?? '';
      yield { kind: 'delta', text: `收到：${last.slice(0, 20)}` };
      yield { kind: 'done', finishReason: 'stop' };
    },
  };

  const gateway = new ProviderGateway({ provider, models: FAKE_MODELS, firstChunkTimeoutMs: 2_000 });
  const app = createApp({ store, gateway });
  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();

  const first = (await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: thread.id, prompt: '第一句' } })).json();
  await waitFor(app, first.id, (body) => body.state === 'succeeded');

  const second = (await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: thread.id, prompt: '第二句' } })).json();
  await waitFor(app, second.id, (body) => body.state === 'succeeded');

  assert.equal(calls.length, 2);
  const secondCall = calls[1] ?? [];
  assert.ok(secondCall[0]?.startsWith('system:'), '第一段必须是系统提示');
  assert.ok(secondCall.some((line) => line.startsWith('user:第一句')), '上一轮的问句要在');
  assert.ok(secondCall.some((line) => line.startsWith('assistant:收到：第一句')), '上一轮的回答要在');
  assert.equal(secondCall.at(-1), 'user:第二句');
  await app.close();
});

test('新会话用第一句话当标题，且能重命名与删除', async () => {
  const app = makeApp();
  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();
  assert.equal(thread.title, '新对话');

  const run = (await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: thread.id, prompt: '帮我把京都行程排一下\n顺便看酒店' } })).json();
  await waitFor(app, run.id, (body) => body.state === 'succeeded');

  const list = (await app.inject({ method: 'GET', url: '/v1/threads' })).json();
  assert.equal(list.items[0].title, '帮我把京都行程排一下', '标题只取第一行，且不超过 24 字');

  const renamed = await app.inject({ method: 'PATCH', url: `/v1/threads/${thread.id}`, payload: { title: '京都行程' } });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.json().title, '京都行程');

  const empty = await app.inject({ method: 'PATCH', url: `/v1/threads/${thread.id}`, payload: { title: '  ' } });
  assert.equal(empty.statusCode, 400);

  const removed = await app.inject({ method: 'DELETE', url: `/v1/threads/${thread.id}` });
  assert.equal(removed.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/threads' })).json().items.length, 0);
  assert.equal((await app.inject({ method: 'DELETE', url: `/v1/threads/${thread.id}` })).statusCode, 404);
  await app.close();
});

test('运行失败后能「接着做」，不用重打提示词', async () => {
  const store = new MemoryStore();
  let calls = 0;

  // 前两次（标准档 + 快档）都挂，之后恢复正常
  const provider: ModelProvider = {
    id: 'flaky',
    async *stream(request) {
      calls += 1;
      if (calls <= 2) throw new Error('上游 503');
      const last = request.messages.at(-1)?.content ?? '';
      yield { kind: 'delta', text: `接着做完了：${last.slice(0, 20)}` };
      yield { kind: 'done', finishReason: 'stop' };
    },
  };

  const gateway = new ProviderGateway({ provider, models: FAKE_MODELS, firstChunkTimeoutMs: 2_000 });
  const app = createApp({ store, gateway });
  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();

  const failed = (await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: thread.id, prompt: '把报告写完' } })).json();
  const failedBody = await waitFor(app, failed.id, (body) => body.state === 'failed' || body.state === 'succeeded');
  assert.equal(failedBody.state, 'failed');

  const continued = await app.inject({ method: 'POST', url: `/v1/runs/${failed.id}/continue` });
  assert.equal(continued.statusCode, 202);
  assert.equal(continued.json().continuedFrom, failed.id);
  assert.equal(continued.json().prompt, '接着刚才的做，不要从头开始。');

  const done = await waitFor(app, continued.json().id, (body) => body.state === 'succeeded' || body.state === 'failed');
  assert.equal(done.state, 'succeeded');

  const items = await store.listMessages(thread.id);
  // 降级会写一条 notice，这里只看对话文本
  const texts = items.filter((item) => item.kind === 'text');
  assert.deepEqual(
    texts.map((item) => `${item.role}/${item.kind}`),
    ['user/text', 'user/text', 'assistant/text'],
  );
  assert.equal(texts[1]?.text, '接着刚才的做，不要从头开始。');
  assert.match(texts[2]?.text ?? '', /接着做完了/);
  assert.ok(calls >= 3, '第一次运行两次都挂，继续之后才成功');
  await app.close();
});

test('还在跑的运行不能继续（409），自定义指令会替换默认措辞', async () => {
  const store = new MemoryStore();
  const app = createApp({ store });

  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();
  const run = (await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: thread.id, prompt: '跑起来' } })).json();
  await store.patchRun(run.id, { state: 'running' });

  const blocked = await app.inject({ method: 'POST', url: `/v1/runs/${run.id}/continue` });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().error, 'run_active');

  await store.patchRun(run.id, { state: 'canceled', finishedAt: new Date().toISOString() });
  const custom = await app.inject({
    method: 'POST',
    url: `/v1/runs/${run.id}/continue`,
    payload: { instruction: '换个思路，先看日志' },
  });
  assert.equal(custom.statusCode, 202);
  assert.equal(custom.json().prompt, '换个思路，先看日志');

  const missing = await app.inject({ method: 'POST', url: '/v1/runs/nope/continue' });
  assert.equal(missing.statusCode, 404);
  await app.close();
});

test('自动化：增删改查 + 立即运行 + 到点自动触发', async () => {
  const store = new MemoryStore();
  const app = makeApp({ store, automationIntervalMs: 60 });

  const created = await app.inject({
    method: 'POST',
    url: '/v1/automations',
    payload: { name: '晨间简报', schedule: '0 8 * * *', prompt: '汇总今天的日程' },
  });
  assert.equal(created.statusCode, 201);
  const automation = created.json();
  assert.equal(automation.enabled, true);
  assert.equal(automation.human, '每天 08:00');

  const bad = await app.inject({ method: 'POST', url: '/v1/automations', payload: { name: 'x', schedule: '0 25 * * *', prompt: 'y' } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'invalid_schedule');

  const listed = (await app.inject({ method: 'GET', url: '/v1/automations' })).json();
  assert.equal(listed.items.length, 1);

  // 立即运行：开一个会话、起一个运行
  const ran = await app.inject({ method: 'POST', url: `/v1/automations/${automation.id}/run` });
  assert.equal(ran.statusCode, 202);
  const { threadId, runId } = ran.json();
  assert.ok(threadId && runId);
  await waitFor(app, runId, (body) => body.state === 'succeeded');

  const threads = (await app.inject({ method: 'GET', url: '/v1/threads' })).json();
  assert.match(threads.items[0].title, /晨间简报/);

  const paused = await app.inject({ method: 'PATCH', url: `/v1/automations/${automation.id}`, payload: { enabled: false } });
  assert.equal(paused.json().enabled, false);

  // 到点自动触发：每分钟都命中的表达式 + 60ms 的巡检间隔
  const always = await app.inject({
    method: 'POST',
    url: '/v1/automations',
    payload: { name: '每分钟跑一次', schedule: '* * * * *', prompt: '看一眼状态' },
  });
  assert.equal(always.statusCode, 201);

  let fired = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(50);
    const list = (await app.inject({ method: 'GET', url: '/v1/automations' })).json();
    fired = list.items.find((item: { id: string; lastRunAt: string | null }) => item.id === always.json().id && item.lastRunAt);
    if (fired) break;
  }
  assert.ok(fired, '定时任务应该在巡检里被触发一次');

  const removed = await app.inject({ method: 'DELETE', url: `/v1/automations/${automation.id}` });
  assert.equal(removed.statusCode, 200);
  assert.equal((await app.inject({ method: 'DELETE', url: `/v1/automations/${automation.id}` })).statusCode, 404);
  await app.close();
});

test('记忆：增删改查，四类 kind 才合法', async () => {
  const app = makeApp();

  const created = await app.inject({
    method: 'POST',
    url: '/v1/memories',
    payload: { kind: 'user', title: '偏好简洁回答', description: '沟通风格', body: '不喜欢客套，直接给结论。' },
  });
  assert.equal(created.statusCode, 201);
  const memory = created.json();
  assert.equal(memory.kind, 'user');

  const badKind = await app.inject({
    method: 'POST',
    url: '/v1/memories',
    payload: { kind: 'whatever', title: 'x', body: 'y' },
  });
  assert.equal(badKind.statusCode, 400);

  const emptyTitle = await app.inject({ method: 'POST', url: '/v1/memories', payload: { kind: 'project', title: '  ', body: 'y' } });
  assert.equal(emptyTitle.statusCode, 400);

  const listed = (await app.inject({ method: 'GET', url: '/v1/memories' })).json();
  assert.equal(listed.items.length, 1);

  const updated = await app.inject({
    method: 'PATCH',
    url: `/v1/memories/${memory.id}`,
    payload: { kind: 'feedback', body: '改成：先给结论，再给理由。' },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().kind, 'feedback');
  assert.match(updated.json().body, /先给结论/);

  assert.equal((await app.inject({ method: 'DELETE', url: `/v1/memories/${memory.id}` })).statusCode, 200);
  assert.equal((await app.inject({ method: 'DELETE', url: `/v1/memories/${memory.id}` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/memories' })).json().items.length, 0);
  await app.close();
});

test('记忆会被带进系统提示，下一次对话就能用上', async () => {
  const seen: string[] = [];
  const provider: ModelProvider = {
    id: 'peek',
    async *stream(request) {
      seen.push(request.messages[0]?.content ?? '');
      yield { kind: 'delta', text: '好。' };
      yield { kind: 'done', finishReason: 'stop' };
    },
  };

  const store = new MemoryStore();
  const gateway = new ProviderGateway({ provider, models: FAKE_MODELS, firstChunkTimeoutMs: 2_000 });
  const app = createApp({ store, gateway });

  await store.createMemory({ kind: 'user', title: '回答先给结论', description: '沟通风格', body: '不要客套，先给结论。' });

  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();
  const run = (await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: thread.id, prompt: '帮我看看构建' } })).json();
  await waitFor(app, run.id, (body) => body.state === 'succeeded');

  assert.match(seen[0] ?? '', /## 用户的记忆（跨会话）/, '系统提示里要有记忆段');
  assert.match(seen[0] ?? '', /回答先给结论/, '记忆的标题要出现');
  assert.match(seen[0] ?? '', /不要客套/, '记忆的正文要出现');
  await app.close();
});

test('技能：内置三个、可挂载、挂上之后进系统提示', async () => {
  const seen: string[] = [];
  const provider: ModelProvider = {
    id: 'peek-skill',
    async *stream(request) {
      seen.push(request.messages[0]?.content ?? '');
      yield { kind: 'delta', text: '好。' };
      yield { kind: 'done', finishReason: 'stop' };
    },
  };

  const store = new MemoryStore();
  const gateway = new ProviderGateway({ provider, models: FAKE_MODELS, firstChunkTimeoutMs: 2_000 });
  const app = createApp({ store, gateway });

  const listed = (await app.inject({ method: 'GET', url: '/v1/skills' })).json();
  assert.equal(listed.items.length, 4);
  assert.ok(listed.items.every((item: { builtin: boolean; enabled: boolean }) => item.builtin && !item.enabled));

  const review = listed.items.find((item: { slug: string }) => item.slug === 'code-review');
  const on = await app.inject({ method: 'PATCH', url: `/v1/skills/${review.id}`, payload: { enabled: true } });
  assert.equal(on.statusCode, 200);
  assert.equal(on.json().enabled, true);

  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();
  const run = (await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: thread.id, prompt: '看看这段改动' } })).json();
  await waitFor(app, run.id, (body) => body.state === 'succeeded');

  assert.match(seen[0] ?? '', /## 已挂载的技能/, '系统提示里要有技能段');
  assert.match(seen[0] ?? '', /代码审查/, '技能名要出现');
  assert.match(seen[0] ?? '', /只报能复现的问题/, '技能正文要出现');

  // 关掉之后就不再带
  await app.inject({ method: 'PATCH', url: `/v1/skills/${review.id}`, payload: { enabled: false } });
  const second = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();
  const run2 = (await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: second.id, prompt: '再来一次' } })).json();
  await waitFor(app, run2.id, (body) => body.state === 'succeeded');
  assert.doesNotMatch(seen.at(-1) ?? '', /## 已挂载的技能/);

  // 自建技能可以删，内置的不能
  const created = await app.inject({ method: 'POST', url: '/v1/skills', payload: { name: '我的规矩', description: '自定义', body: '每次先复述需求。' } });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().builtin, false);
  assert.equal((await app.inject({ method: 'DELETE', url: `/v1/skills/${review.id}` })).statusCode, 409);
  assert.equal((await app.inject({ method: 'DELETE', url: `/v1/skills/${created.json().id}` })).statusCode, 200);
  await app.close();
});

test('技能可以收窄工具集：挂上「只读模式」就写不了文件', async () => {
  const asked: string[][] = [];
  const provider: ModelProvider = {
    id: 'tool-peek',
    async *stream(request) {
      // 记下模型看到的工具清单
      asked.push((request.tools ?? []).map((tool) => tool.name));
      yield { kind: 'tool_call', callId: 'c1', name: 'write_file', args: { path: 'x.txt', content: 'y' } };
      yield { kind: 'done', finishReason: 'tool_use' };
    },
  };

  const store = new MemoryStore();
  const gateway = new ProviderGateway({ provider, models: FAKE_MODELS, firstChunkTimeoutMs: 2_000 });

  const workspace = await mkdtemp(path.join(tmpdir(), 'rakko-skill-tools-'));
  const tools = new ToolRegistry({ workspace });
  for (const tool of createBuiltinTools({ workspace })) tools.register(tool);
  for (const tool of createSecondToolset({ workspace })) tools.register(tool);
  const app = createApp({ store, gateway, tools, workspace });

  const skills = (await app.inject({ method: 'GET', url: '/v1/skills' })).json();
  const readOnly = skills.items.find((item: { slug: string }) => item.slug === 'read-only');
  assert.ok(readOnly, '内置应该有一个「只读模式」');
  assert.deepEqual(readOnly.tools, ['read_file', 'list_dir', 'grep']);

  await app.inject({ method: 'PATCH', url: `/v1/skills/${readOnly.id}`, payload: { enabled: true } });

  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();
  const run = (await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: thread.id, prompt: '帮我把结论写进文件' } })).json();
  await waitFor(app, run.id, (body) => body.state === 'succeeded' || body.state === 'failed');

  // 模型看到的工具清单里不该有写文件/跑命令
  const firstCall = asked[0] ?? [];
  assert.deepEqual([...firstCall].sort(), ['grep', 'list_dir', 'read_file']);

  // 越权调用会被挡回来，而不是真的写盘
  const items = await store.listMessages(thread.id);
  const results = items.filter((item) => item.kind === 'tool_result');
  assert.ok(results.length >= 1);
  assert.match(String(results[0]?.payload?.output ?? ''), /技能没启用 write_file/);
  await app.close();
});

test('挂载的技能限制工具时，/health 会说出来', async () => {
  const app = makeApp();

  const before = (await app.inject({ method: 'GET', url: '/health' })).json();
  assert.equal(before.restrictedTools, undefined);

  const skills = (await app.inject({ method: 'GET', url: '/v1/skills' })).json();
  const readOnly = skills.items.find((item: { slug: string }) => item.slug === 'read-only');
  await app.inject({ method: 'PATCH', url: `/v1/skills/${readOnly.id}`, payload: { enabled: true } });

  const after = (await app.inject({ method: 'GET', url: '/health' })).json();
  assert.deepEqual([...after.restrictedTools].sort(), ['grep', 'list_dir', 'read_file']);
  await app.close();
});

test('插件接口：列表 + 手动重载能拿到新文件', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rakko-plugin-api-'));
  await writeFile(
    path.join(dir, 'first.mjs'),
    "export const name = 'first_tool';\nexport const description = '第一个插件';\nexport async function run() { return 'one'; }\n",
    'utf8',
  );

  const store = new MemoryStore();
  const workspace = await mkdtemp(path.join(tmpdir(), 'rakko-plugin-ws-'));
  const tools = new ToolRegistry({ workspace });
  for (const tool of createBuiltinTools({ workspace })) tools.register(tool);

  const plugins = new PluginHost(tools, { directory: dir });
  await plugins.reload();

  const app = createApp({ store, tools, workspace, plugins });

  const listed = (await app.inject({ method: 'GET', url: '/v1/plugins' })).json();
  assert.equal(listed.directory, dir);
  assert.deepEqual(listed.tools.map((tool: { name: string }) => tool.name), ['first_tool']);
  assert.equal(listed.errors.length, 0);

  // 新增一个插件再手动重载
  await writeFile(
    path.join(dir, 'second.mjs'),
    "export const name = 'second_tool';\nexport const description = '第二个插件';\nexport async function run() { return 'two'; }\n",
    'utf8',
  );
  const reloaded = (await app.inject({ method: 'POST', url: '/v1/plugins/reload' })).json();
  assert.deepEqual(reloaded.tools.map((tool: { name: string }) => tool.name).sort(), ['first_tool', 'second_tool']);

  // 注册表里也该有它
  const health = (await app.inject({ method: 'GET', url: '/health' })).json();
  assert.ok(health.tools.some((tool: { name: string }) => tool.name === 'second_tool'));

  plugins.close();
  await app.close();
});

test('没有插件宿主时，接口给出明确回应而不是 500', async () => {
  const app = makeApp();
  const listed = (await app.inject({ method: 'GET', url: '/v1/plugins' })).json();
  assert.equal(listed.directory, null);
  assert.deepEqual(listed.tools, []);

  const reload = await app.inject({ method: 'POST', url: '/v1/plugins/reload' });
  assert.equal(reload.statusCode, 400);
  assert.equal(reload.json().error, 'plugins_unavailable');
  await app.close();
});

test('语义检索：查询命中的记忆排在最前，最多带 8 条', async () => {
  const store = new MemoryStore();

  // 一条跟「数据库」相关，八条不相干
  await store.createMemory({ kind: 'project', title: 'Postgres 独占事实源', body: '不做本地缓存。', embedding: [1, 0, 0] });
  for (let i = 0; i < 8; i += 1) {
    await store.createMemory({ kind: 'user', title: `无关记忆 ${i}`, body: '跟数据库没关系', embedding: [0, 1, 0] });
  }

  const hits = await store.searchMemories({ query: '数据库用什么', embedding: [1, 0, 0], limit: 8, minScore: 0.25 });
  assert.deepEqual(hits.map((memory) => memory.title), ['Postgres 独占事实源'], '只留过阈值的');

  const keywordOnly = await store.searchMemories({ query: '本地缓存', embedding: null, limit: 3 });
  assert.ok(keywordOnly.some((memory) => memory.title === 'Postgres 独占事实源'), '没有向量时按关键词兜底');
});

test('知识图谱：三元组落库，接口能读到', async () => {
  const store = new MemoryStore();
  const memory = await store.createMemory({ kind: 'project', title: 'Rakko 用 Postgres', body: '唯一事实源。' });

  await store.saveTriples(memory.id, [
    { from: 'Rakko', fromKind: 'project', relation: '使用', to: 'Postgres', toKind: 'tool' },
    { from: 'Postgres', fromKind: 'tool', relation: '承担', to: '消息持久化', toKind: 'concept' },
  ]);

  const app = createApp({ store });
  const graph = (await app.inject({ method: 'GET', url: '/v1/graph' })).json();

  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 2);
  assert.deepEqual(
    graph.edges.map((edge: { relation: string }) => edge.relation).sort(),
    ['使用', '承担'],
  );
  await app.close();
});

test('记忆段会按查询挑：相关的进系统提示，不相关的排在后面', async () => {
  const seen: string[] = [];
  const provider: ModelProvider = {
    id: 'peek-memory',
    async *stream(request) {
      seen.push(request.messages[0]?.content ?? '');
      yield { kind: 'delta', text: '好。' };
      yield { kind: 'done', finishReason: 'stop' };
    },
  };

  const store = new MemoryStore();
  await store.createMemory({ kind: 'project', title: 'Postgres 独占事实源', body: '不做本地缓存。', embedding: [1, 0, 0] });
  await store.createMemory({ kind: 'user', title: '回答先给结论', body: '不要客套。', embedding: [0, 1, 0] });

  const embeddings = {
    model: 'stub',
    dims: 3,
    embed: async () => [[1, 0, 0]],
  };

  const gateway = new ProviderGateway({ provider, models: FAKE_MODELS, firstChunkTimeoutMs: 2_000 });
  const app = createApp({ store, gateway, embeddings });

  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();
  const run = (await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: thread.id, prompt: '数据库用的是什么' } })).json();
  await waitFor(app, run.id, (body) => body.state === 'succeeded');

  const system = seen[0] ?? '';
  assert.match(system, /用户的记忆（跨会话）/);
  assert.ok(system.includes('Postgres 独占事实源'), '相关的记忆要在');
  assert.ok(!system.includes('回答先给结论'), '余弦 0 的不该塞进来');
  await app.close();
});

test('图谱扩展：语义只召回一条，靠关系把相邻记忆也带进来', async () => {
  const store = new MemoryStore();

  // A 与查询语义相近；B 语义无关，但和 A 共享实体「Postgres」
  const a = await store.createMemory({ kind: 'project', title: 'Postgres 独占事实源', body: '不做本地缓存。', embedding: [1, 0, 0] });
  const b = await store.createMemory({ kind: 'feedback', title: '迁移必须先备份', body: '改表结构前先 dump。', embedding: [0, 1, 0] });

  await store.saveTriples(a.id, [{ from: 'Rakko', fromKind: 'project', relation: '使用', to: 'Postgres', toKind: 'tool' }]);
  await store.saveTriples(b.id, [{ from: 'Postgres', fromKind: 'tool', relation: '变更', to: '迁移备份', toKind: 'concept' }]);

  const direct = await store.searchMemories({ query: '数据库', embedding: [1, 0, 0], limit: 8 });
  assert.equal(direct[0]?.id, a.id);

  const related = await store.expandFromMemories([a.id], 4);
  assert.deepEqual(related.map((memory) => memory.title), ['迁移必须先备份']);
});

test('图谱扩展后的记忆会带「关联记忆」标记进系统提示', async () => {
  const seen: string[] = [];
  const provider: ModelProvider = {
    id: 'peek-graph',
    async *stream(request) {
      seen.push(request.messages[0]?.content ?? '');
      yield { kind: 'delta', text: '好。' };
      yield { kind: 'done', finishReason: 'stop' };
    },
  };

  const store = new MemoryStore();
  // A 与查询同向；B 反向（语义上前 8 名进不去）；再放 7 条中性的把名额占满
  const a = await store.createMemory({ kind: 'project', title: 'Postgres 独占事实源', body: '不做本地缓存。', embedding: [1, 0] });
  const b = await store.createMemory({ kind: 'feedback', title: '迁移必须先备份', body: '改表结构前先 dump。', embedding: [-1, 0] });
  for (let i = 0; i < 7; i += 1) {
    await store.createMemory({ kind: 'user', title: `中性记忆 ${i}`, body: '和数据库无关', embedding: [0, 1] });
  }

  await store.saveTriples(a.id, [{ from: 'Rakko', relation: '使用', to: 'Postgres', fromKind: 'project', toKind: 'tool' }]);
  await store.saveTriples(b.id, [{ from: 'Postgres', relation: '变更', to: '迁移备份', fromKind: 'tool', toKind: 'concept' }]);

  const embeddings = { model: 'stub', dims: 2, embed: async () => [[1, 0]] };
  const gateway = new ProviderGateway({ provider, models: FAKE_MODELS, firstChunkTimeoutMs: 2_000 });
  const app = createApp({ store, gateway, embeddings });

  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();
  const run = (await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: thread.id, prompt: '数据库用什么' } })).json();
  await waitFor(app, run.id, (body) => body.state === 'succeeded');

  const system = seen[0] ?? '';
  assert.match(system, /Postgres 独占事实源/);
  assert.match(system, /迁移必须先备份/, '相邻记忆要被带进来');
  assert.ok(system.includes('[feedback]（关联记忆）'), '要标出来源');
  await app.close();
});

test('实体名归一化：Postgres 与 postgres 是同一个节点', async () => {
  const store = new MemoryStore();
  const a = await store.createMemory({ kind: 'project', title: 'Rakko 用 Postgres', body: '.' });
  const b = await store.createMemory({ kind: 'project', title: 'postgres 版本', body: '.' });

  await store.saveTriples(a.id, [{ from: 'Rakko', relation: '使用', to: 'Postgres' }]);
  await store.saveTriples(b.id, [{ from: 'Rakko', relation: '使用', to: ' postgres ' }]);

  const graph = await store.listGraph();
  const names = graph.nodes.map((node) => node.name).sort();
  assert.deepEqual(names, ['Postgres', 'Rakko'], '大小写与空格不同的实体要合并');
  assert.equal(graph.edges.length, 1, '三元组重复，只留一条边');
});

test('低于余弦阈值的记忆不会被注入，关键词命中仍然算', async () => {
  const seen: string[] = [];
  const provider: ModelProvider = {
    id: 'peek-threshold',
    async *stream(request) {
      seen.push(request.messages[0]?.content ?? '');
      yield { kind: 'delta', text: '好。' };
      yield { kind: 'done', finishReason: 'stop' };
    },
  };

  const store = new MemoryStore();
  // 与查询正交（余弦 0）：不该进提示
  await store.createMemory({ kind: 'user', title: '无关偏好', body: '喜欢蓝色。', embedding: [0, 1] });
  // 与查询同向（余弦 1）：必须进
  await store.createMemory({ kind: 'project', title: '数据库选型', body: '用 Postgres。', embedding: [1, 0] });

  const embeddings = { model: 'stub', dims: 2, embed: async () => [[1, 0]] };
  const gateway = new ProviderGateway({ provider, models: FAKE_MODELS, firstChunkTimeoutMs: 2_000 });
  const app = createApp({ store, gateway, embeddings });

  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();
  const run = (await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: thread.id, prompt: '数据库选型怎么定' } })).json();
  await waitFor(app, run.id, (body) => body.state === 'succeeded');

  const system = seen[0] ?? '';
  assert.ok(system.includes('数据库选型'), '过阈值的要在');
  const section = system.split('## 用户的记忆（跨会话）')[1] ?? '';
  assert.ok(!section.includes('无关偏好'), '低相关度的不该塞进来');
  await app.close();
});

test('孤立实体被剪掉，不留垃圾节点', { skip: !process.env.DATABASE_URL }, async () => {
  const handle = createDb(process.env.DATABASE_URL!, { max: 2 });
  await migrateDb(handle);

  const email = `prune-${Date.now()}@rakko.app`;
  const store = new PostgresStore(handle, { email, plan: 'pro' });
  await store.ready();

  try {
    const userId = (await handle.sql<{ id: string }[]>`select id from users where email = ${email}`)[0]?.id;
    assert.ok(userId);

    // 直接塞一个没有任何边的节点
    await handle.sql`insert into kg_nodes (user_id, name, key, kind) values (${userId}, '孤儿节点', '孤儿节点', 'concept')`;

    const removed = await store.pruneOrphanNodes();
    assert.ok(removed >= 1);

    const left = await handle.sql<{ count: number }[]>`
      select count(*)::int as count from kg_nodes where user_id = ${userId} and key = '孤儿节点'
    `;
    assert.equal(left[0]?.count, 0);
  } finally {
    await handle.sql`delete from users where email = ${email}`;
    await store.close();
  }
});

test('消息分页：默认一页 30 条，往前的用 before 翻', async () => {
  const store = new MemoryStore();
  const provider: ModelProvider = {
    id: 'paging',
    async *stream() {
      yield { kind: 'delta', text: '好。' };
      yield { kind: 'done', finishReason: 'stop' };
    },
  };
  const app = createApp({ store, provider });

  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: { title: '长会话' } })).json();
  for (let i = 1; i <= 45; i += 1) {
    await store.appendMessage({ threadId: thread.id, role: i % 2 ? 'user' : 'assistant', kind: 'text', text: `第 ${i} 条` });
  }

  const first = (await app.inject({ method: 'GET', url: `/v1/threads/${thread.id}/messages` })).json();
  assert.equal(first.items.length, 30, '默认一页 30 条');
  assert.equal(first.hasMore, true);
  assert.equal(first.items[0].text, '第 16 条', '返回最近的 30 条，升序');
  assert.equal(first.items.at(-1).text, '第 45 条');

  const older = (await app.inject({ method: 'GET', url: `/v1/threads/${thread.id}/messages?before=${first.items[0].seq}` })).json();
  assert.equal(older.items.length, 15, '剩下 15 条');
  assert.equal(older.hasMore, false);
  assert.equal(older.items[0].text, '第 1 条');
  assert.equal(older.items.at(-1).text, '第 15 条');

  const small = (await app.inject({ method: 'GET', url: `/v1/threads/${thread.id}/messages?limit=5` })).json();
  assert.equal(small.items.length, 5);
  assert.deepEqual(small.items.map((m: { text: string }) => m.text), ['第 41 条', '第 42 条', '第 43 条', '第 44 条', '第 45 条']);

  const bad = await app.inject({ method: 'GET', url: `/v1/threads/${thread.id}/messages?limit=0` });
  assert.equal(bad.statusCode, 400, 'limit 越界要报错');

  await app.close();
});

test('运行记录：接口给出 run + 事件流水 + 体检报告', async () => {
  const store = new MemoryStore();
  const provider: ModelProvider = {
    id: 'trace',
    async *stream() {
      yield { kind: 'delta', text: '好了。' };
      yield { kind: 'done', finishReason: 'stop' };
    },
  };
  const app = createApp({ store, provider });

  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();
  const run = (await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: thread.id, prompt: '你好' } })).json();
  await waitFor(app, run.id, (body) => body.state === 'succeeded');

  const trace = (await app.inject({ method: 'GET', url: `/v1/runs/${run.id}/trace` })).json();
  assert.equal(trace.run.id, run.id);
  assert.ok(trace.events.length > 0, '要有事件流水');
  assert.equal(trace.events[0].type, 'run.started');
  assert.equal(trace.summary.state, 'succeeded');
  assert.equal(trace.summary.model, run.model);
  assert.equal(typeof trace.summary.durationMs, 'number');
  assert.ok(trace.summary.firstTokenMs !== null, '有输出就该有首字耗时');
  assert.deepEqual(trace.summary.tools, [], '这次没调工具');

  const missing = await app.inject({ method: 'GET', url: '/v1/runs/nope/trace' });
  assert.equal(missing.statusCode, 404);
  await app.close();
});

test('分叉：复制到某条消息之前，原会话一点不动', async () => {
  const store = new MemoryStore();
  const provider: ModelProvider = {
    id: 'fork',
    async *stream() {
      yield { kind: 'delta', text: '收到。' };
      yield { kind: 'done', finishReason: 'stop' };
    },
  };
  const app = createApp({ store, provider });

  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: { title: '原会话' } })).json();
  const first = await store.appendMessage({ threadId: thread.id, role: 'user', kind: 'text', text: '第一句' });
  await store.appendMessage({ threadId: thread.id, role: 'assistant', kind: 'text', text: '第一答' });
  const third = await store.appendMessage({ threadId: thread.id, role: 'user', kind: 'text', text: '第二句' });

  const forked = (await app.inject({
    method: 'POST',
    url: `/v1/threads/${thread.id}/fork`,
    payload: { messageId: third.id },
  })).json();

  assert.equal(forked.copied, 2, '第三句之前有两条');
  assert.match(forked.thread.title, /分叉/);
  const copied = (await app.inject({ method: 'GET', url: `/v1/threads/${forked.thread.id}/messages` })).json();
  assert.deepEqual(copied.items.map((m: { text: string }) => m.text), ['第一句', '第一答'], '顺序与内容都要保住');
  assert.deepEqual(copied.items.map((m: { seq: number }) => m.seq), [1, 2], 'seq 从 1 重新排');

  const origin = (await app.inject({ method: 'GET', url: `/v1/threads/${thread.id}/messages` })).json();
  assert.equal(origin.items.length, 3, '原会话不能被改');
  assert.equal(origin.items[2].text, '第二句');

  // 连自己一起复制
  const through = (await app.inject({
    method: 'POST',
    url: `/v1/threads/${thread.id}/fork`,
    payload: { messageId: third.id, includeTarget: true, title: '另开一枝' },
  })).json();
  assert.equal(through.copied, 3);
  assert.equal(through.thread.title, '另开一枝', '可以指定标题');

  // 从第一条之前分叉 = 空会话
  const empty = (await app.inject({
    method: 'POST',
    url: `/v1/threads/${thread.id}/fork`,
    payload: { messageId: first.id },
  })).json();
  assert.equal(empty.copied, 0);

  // 消息不属于这个会话
  const other = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();
  const alien = await store.appendMessage({ threadId: other.id, role: 'user', kind: 'text', text: '别处的' });
  const bad = await app.inject({ method: 'POST', url: `/v1/threads/${thread.id}/fork`, payload: { messageId: alien.id } });
  assert.equal(bad.statusCode, 404);

  const missing = await app.inject({ method: 'POST', url: '/v1/threads/nope/fork', payload: { messageId: third.id } });
  assert.equal(missing.statusCode, 404);

  await app.close();
});

test('运行概览：接口给成功率与工具失败榜，「接着做」记来源', async () => {
  const store = new MemoryStore();
  const provider: ModelProvider = {
    id: 'overview',
    async *stream() {
      yield { kind: 'delta', text: '好。' };
      yield { kind: 'done', finishReason: 'stop' };
    },
  };
  const app = createApp({ store, provider });

  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();
  const run = (await app.inject({ method: 'POST', url: '/v1/runs', payload: { threadId: thread.id, prompt: '第一轮' } })).json();
  await waitFor(app, run.id, (body) => body.state === 'succeeded');

  const again = (await app.inject({ method: 'POST', url: `/v1/runs/${run.id}/continue`, payload: {} })).json();
  await waitFor(app, again.id, (body) => body.state === 'succeeded');

  const overview = (await app.inject({ method: 'GET', url: '/v1/runs/overview?limit=10' })).json();
  assert.equal(overview.items.length, 2);
  assert.equal(overview.items[0].id, again.id, '最新的在前');
  assert.equal(overview.items[0].source, 'continue');
  assert.equal(overview.items[1].source, 'chat');
  assert.equal(overview.stats.successRate, 100);
  assert.ok(overview.stats.p50Ms !== null);
  assert.deepEqual(overview.stats.topTools, [], '没调工具就没有榜单');

  const clamped = (await app.inject({ method: 'GET', url: '/v1/runs/overview?limit=9999' })).json();
  assert.ok(Array.isArray(clamped.items));
  await app.close();
});
