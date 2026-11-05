#!/usr/bin/env node
/**
 * 边界压测：同一会话并发追加消息。
 *
 * 只看「全部成功 + seq 无重复 + 条数对得上」，
 * 不关心实现是重试、行锁还是计数器 —— 那是 agent 的自由。
 */

import { createDb, migrateDb } from '@rakko/db';
import { PostgresStore } from '@rakko/server/postgres-store';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.log('✗ 需要 DATABASE_URL（先 docker compose up -d db）');
  process.exit(1);
}

const CONCURRENCY = [20, 40];
const handle = createDb(databaseUrl, { max: 20 });
await migrateDb(handle);

const email = `accept-concurrent-${Date.now()}@rakko.app`;
const store = new PostgresStore(handle, { email, plan: 'free' });
await store.ready();

const failures = [];

try {
  const thread = await store.createThread('边界压测');
  let expected = 0;

  for (const n of CONCURRENCY) {
    const results = await Promise.allSettled(
      Array.from({ length: n }, (_, i) => store.appendMessage({ threadId: thread.id, role: 'user', text: `并发 ${n}-${i}` })),
    );
    expected += n;

    const rejected = results.filter((item) => item.status === 'rejected');
    const [row] = await handle.sql`
      select count(*)::int as count, count(distinct seq)::int as distinct
      from messages where thread_id = ${thread.id}
    `;

    const ok = rejected.length === 0 && row?.count === expected && row?.distinct === expected;
    console.log(
      `${ok ? '✓' : '✗'} 并发 ${n}：成功 ${n - rejected.length}/${n} · 库中 ${row?.count} 条 · seq 去重 ${row?.distinct} 个（期望 ${expected}）`,
    );
    if (!ok) {
      failures.push(`并发 ${n}`);
      if (rejected.length > 0) console.log(`    首个失败：${String(rejected[0]?.reason ?? '').split('\n')[0].slice(0, 200)}`);
    }
  }
} finally {
  await handle.sql`delete from users where email = ${email}`;
  await store.close();
}

if (failures.length > 0) {
  console.log(`\n不达标：${failures.join('、')}`);
  process.exit(1);
}
console.log('\n并发边界全部通过');
