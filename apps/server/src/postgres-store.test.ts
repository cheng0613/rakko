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

test('并发追加 5 条消息全部成功，seq 不重复', { skip: !databaseUrl }, async () => {
  const handle = createDb(databaseUrl!, { max: 10 });
  await migrateDb(handle);

  const email = `concurrent-append-${Date.now()}@rakko.app`;
  const store = new PostgresStore(handle, { email, plan: 'free' });
  await store.ready();

  try {
    const thread = await store.createThread('并发写消息');
    const N = 5;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.appendMessage({ threadId: thread.id, role: 'user', text: `并发消息 ${i + 1}` }),
      ),
    );

    assert.equal(results.length, N, `期望 ${N} 条全部成功，实际返回 ${results.length} 条`);

    // 直接查库验证 seq 不重复
    const rows = await handle.db.query.messages.findMany({
      where: (messages, { eq }) => eq(messages.threadId, thread.id),
      columns: { seq: true },
      orderBy: (messages, { asc }) => [asc(messages.seq)],
    });
    const seqs = rows.map((r) => r.seq);
    assert.equal(seqs.length, N, `库中应有 ${N} 条消息`);
    assert.equal(new Set(seqs).size, N, `seq 不应重复，实际 seqs: ${JSON.stringify(seqs)}`);
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

test('同一会话 20 条并发追加：全部成功且 seq 不重复', { skip: !databaseUrl }, async () => {
  const handle = createDb(databaseUrl!, { max: 10 });
  await migrateDb(handle);

  const email = `stress-append-${Date.now()}@rakko.app`;
  const store = new PostgresStore(handle, { email, plan: 'free' });
  await store.ready();

  try {
    const thread = await store.createThread('并发压测');
    const N = 20;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) => store.appendMessage({ threadId: thread.id, role: 'user', text: `并发 ${i}` })),
    );

    const rejected = results.filter((item) => item.status === 'rejected');
    assert.equal(rejected.length, 0, `不该有失败，实际失败 ${rejected.length} 条：${String(rejected[0]?.reason ?? '')}`);

    const [row] = await handle.sql<{ count: number; distinct: number }[]>`
      select count(*)::int as count, count(distinct seq)::int as distinct
      from messages where thread_id = ${thread.id}
    `;
    assert.equal(row?.count, N);
    assert.equal(row?.distinct, N, 'seq 不能重复');
  } finally {
    await handle.sql`delete from users where email = ${email}`;
    await store.close();
  }
});

test('语义检索的 HNSW 索引确实建在库里', { skip: !databaseUrl }, async () => {
  const handle = createDb(databaseUrl!, { max: 2 });
  await migrateDb(handle);

  try {
    const rows = await handle.sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes
      where tablename = 'memories' and indexname = 'memories_embedding_hnsw'
    `;
    assert.equal(rows.length, 1, '迁移应该建出 memories_embedding_hnsw');
    assert.match(rows[0]?.indexdef ?? '', /USING hnsw/);
    assert.match(rows[0]?.indexdef ?? '', /vector_cosine_ops/);
  } finally {
    await handle.close();
  }
});

test('真库分页：40 条消息按 15 条一页翻完，顺序不乱', { skip: !databaseUrl }, async () => {
  const handle = createDb(databaseUrl!, { max: 2 });
  await migrateDb(handle);

  const email = `paging-${Date.now()}@rakko.app`;
  const store = new PostgresStore(handle, { email, plan: 'pro' });
  await store.ready();

  try {
    const thread = await store.createThread('分页测试');
    for (let i = 1; i <= 40; i += 1) {
      await store.appendMessage({ threadId: thread.id, role: 'user', kind: 'text', text: `第 ${i} 条` });
    }

    const seen: string[] = [];
    let before: number | undefined;
    let pages = 0;
    for (;;) {
      const page = await store.pageMessages(thread.id, { limit: 15, ...(before ? { beforeSeq: before } : {}) });
      seen.unshift(...page.items.map((message) => message.text));
      pages += 1;
      if (!page.hasMore) break;
      before = page.items[0]?.seq;
    }

    assert.equal(pages, 3, '40 条 / 每页 15 → 15 + 15 + 10');
    assert.equal(seen.length, 40);
    assert.deepEqual(seen.slice(0, 3), ['第 1 条', '第 2 条', '第 3 条']);
    assert.deepEqual(seen.slice(-2), ['第 39 条', '第 40 条'], '翻完顺序要正');
  } finally {
    await handle.sql`delete from users where email = ${email}`;
    await store.close();
  }
});

test('真库分叉：结构化消息一起搬走，seq 重排，原会话不动', { skip: !databaseUrl }, async () => {
  const handle = createDb(databaseUrl!, { max: 2 });
  await migrateDb(handle);

  const email = `fork-${Date.now()}@rakko.app`;
  const store = new PostgresStore(handle, { email, plan: 'pro' });
  await store.ready();

  try {
    const thread = await store.createThread('分叉源');
    await store.appendMessage({ threadId: thread.id, role: 'user', kind: 'text', text: '读一下 README' });
    await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      kind: 'tool_call',
      text: '',
      payload: { callId: 'c1', name: 'read_file', args: { path: 'README.md' } },
    });
    const third = await store.appendMessage({ threadId: thread.id, role: 'user', kind: 'text', text: '再总结一下' });

    const forked = await store.forkThread({ threadId: thread.id, messageId: third.id, includeTarget: false });
    assert.ok(forked);
    assert.equal(forked.copied, 2);

    const copied = await store.pageMessages(forked.thread.id, { limit: 10 });
    assert.deepEqual(copied.items.map((m) => m.seq), [1, 2]);
    assert.deepEqual(copied.items.map((m) => m.kind), ['text', 'tool_call']);
    assert.deepEqual(copied.items[1]?.payload, { callId: 'c1', name: 'read_file', args: { path: 'README.md' } });

    const origin = await store.pageMessages(thread.id, { limit: 10 });
    assert.equal(origin.items.length, 3, '原会话三条一条不少');

    const alien = await store.forkThread({ threadId: thread.id, messageId: '00000000-0000-0000-0000-000000000000', includeTarget: true });
    assert.equal(alien, null, '不存在的消息要返回 null');
  } finally {
    await handle.sql`delete from users where email = ${email}`;
    await store.close();
  }
});
