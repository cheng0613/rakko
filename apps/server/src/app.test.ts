import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStore } from './store.js';
import { createApp } from './app.js';

test('健康检查带上 provider 标识，运维一眼能看出接的谁', async () => {
  const app = createApp();
  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'rakko-api');
  assert.equal(body.store, 'memory');
  await app.close();
});

test('建会话返回 201，并能在列表里查到', async () => {
  const app = createApp();
  const created = await app.inject({ method: 'POST', url: '/v1/threads', payload: { title: '迁移 schema' } });
  assert.equal(created.statusCode, 201);
  const thread = created.json();
  assert.equal(thread.title, '迁移 schema');

  const list = await app.inject({ method: 'GET', url: '/v1/threads' });
  assert.equal(list.json().items.length, 1);
  await app.close();
});

test('运行请求缺提示词时返回 400 而不是 500', async () => {
  const app = createApp();
  const response = await app.inject({
    method: 'POST',
    url: '/v1/runs',
    payload: { threadId: 'missing', prompt: '' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'invalid_request');
  await app.close();
});

test('会话不存在时返回 404，并给中文说明', async () => {
  const app = createApp();
  const response = await app.inject({
    method: 'POST',
    url: '/v1/runs',
    payload: { threadId: 'nope', prompt: '看看构建' },
  });
  assert.equal(response.statusCode, 404);
  assert.match(response.json().message, /会话不存在/);
  await app.close();
});

test('配额用完后按设置降级：仍接受运行，但模型换成 fast 并说明原因', async () => {
  const store = new MemoryStore();
  store.setUsage(120);
  const app = createApp({ store });

  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();

  const blocked = await app.inject({
    method: 'POST',
    url: '/v1/runs',
    payload: { threadId: thread.id, prompt: '跑一下测试', model: 'standard' },
  });
  assert.equal(blocked.statusCode, 202);
  assert.equal(blocked.json().degraded, true);
  assert.equal(blocked.json().model, 'fast');
  await app.close();
});

test('会话与用量走同一份存储，接口形状不变', async () => {
  const app = createApp();
  const thread = (await app.inject({ method: 'POST', url: '/v1/threads', payload: {} })).json();

  const response = await app.inject({
    method: 'POST',
    url: '/v1/runs',
    payload: { threadId: thread.id, prompt: '跑一下测试', model: 'standard' },
  });
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().degraded, false);
  assert.equal(response.json().state, 'queued');

  const usage = (await app.inject({ method: 'GET', url: '/v1/usage' })).json();
  assert.equal(usage.plan, 'Pro');
  assert.equal(usage.limit, 120);
  assert.equal(usage.remaining, 120 - usage.used);
  await app.close();
});
