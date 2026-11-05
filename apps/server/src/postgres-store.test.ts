import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDb, migrateDb } from '@rakko/db';

import { PostgresStore } from './postgres-store.js';

const databaseUrl = process.env.DATABASE_URL;

/**
 * 集成测试：只有配了 DATABASE_URL 才跑（CI 无库时自动跳过）。
 * 每次用独立邮箱，跑完按邮箱级联删干净，不污染本地库。
 */
test('九张表真的写进 Postgres，重启后还读得到', { skip: !databaseUrl }, async () => {
  const handle = createDb(databaseUrl!, { max: 2 });
  await migrateDb(handle);

  const email = `store-test-${Date.now()}@rakko.app`;
  const store = new PostgresStore(handle, { email, plan: 'free' });
  await store.ready();

  try {
    assert.equal(store.kind, 'postgres');

    const thread = await store.createThread('集成测试');
    assert.ok(thread.id);

    const run = await store.createRun({ threadId: thread.id, prompt: '写进九张表', model: 'fast' });
    assert.equal(run.state, 'queued');

    await store.appendMessage({ threadId: thread.id, role: 'user', text: '跑起来', runId: run.id });
    await store.publish({ type: 'run.started', runId: run.id, at: new Date().toISOString() });
    await store.publish({ type: 'run.delta', runId: run.id, at: new Date().toISOString(), text: '第一段' });
    await store.publish({ type: 'run.delta', runId: run.id, at: new Date().toISOString(), text: '第二段' });

    const patched = await store.patchRun(run.id, { state: 'running' });
    assert.equal(patched?.state, 'running');

    // 事件 seq 必须严格递增，SSE 续传靠这个
    const events = await store.eventsOf(run.id);
    assert.deepEqual(
      events.map((event) => event.type),
      ['run.started', 'run.delta', 'run.delta'],
    );

    // 消息 seq 由数据库算，第二条必须是 2
    await store.appendMessage({ threadId: thread.id, role: 'assistant', text: '写完了', runId: run.id });
    const messages = await store.listMessages(thread.id);
    assert.equal(messages.length, 2);

    await store.chargeRun(run);
    const usage = await store.usage();
    assert.equal(usage.plan, 'Free');
    assert.equal(usage.limit, 30);
    assert.equal(usage.used, 1);
    assert.equal(usage.remaining, 29);

    // 用同一个邮箱重新构造一个 store，等于模拟进程重启
    const reopened = new PostgresStore(handle, { email, plan: 'free' });
    await reopened.ready();
    assert.equal((await reopened.listThreads()).length, 1);
    assert.equal((await reopened.eventsOf(run.id)).length, 3);
  } finally {
    await handle.sql`delete from users where email = ${email}`;
    await store.close();
  }
});

test('进程重启：queued/running 标失败，waiting_approval 留待恢复', { skip: !databaseUrl }, async () => {
  const handle = createDb(databaseUrl!, { max: 2 });
  await migrateDb(handle);

  const email = `orphan-test-${Date.now()}@rakko.app`;
  const store = new PostgresStore(handle, { email, plan: 'free' });
  await store.ready();

  try {
    const thread = await store.createThread('孤儿运行');
    const halfDone = await store.createRun({ threadId: thread.id, prompt: '跑到一半', model: 'fast' });
    await store.patchRun(halfDone.id, { state: 'running' });

    const args = { path: 'note.txt', content: 'x' };
    const waiting = await store.createRun({ threadId: thread.id, prompt: '等我审批', model: 'fast' });
    await store.patchRun(waiting.id, { state: 'waiting_approval' });
    await store.appendMessage({ threadId: thread.id, role: 'user', kind: 'text', text: '等我审批', runId: waiting.id });
    await store.appendMessage({
      threadId: thread.id, role: 'system', kind: 'approval', text: '',
      payload: { callId: 'call_wait', name: 'write_file', risk: 'high', args }, runId: waiting.id,
    });

    const recovered = await store.recoverOrphans();
    assert.ok(recovered >= 1);

    const after = await store.getRun(halfDone.id);
    assert.equal(after?.state, 'failed');
    assert.match(after?.error ?? '', /被中断/);

    // 等审批的那次还活着，并且能翻出那条待批调用
    assert.equal((await store.getRun(waiting.id))?.state, 'waiting_approval');
    const resumable = await store.resumableRuns();
    const mine = resumable.find((item) => item.run.id === waiting.id);
    assert.ok(mine, 'should be resumable');
    assert.equal(mine?.pending?.callId, 'call_wait');
    assert.equal(mine?.pending?.name, 'write_file');
  } finally {
    await handle.sql`delete from users where email = ${email}`;
    await store.close();
  }
});
