import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getTableColumns, getTableName } from 'drizzle-orm';

import { TABLES } from './schema.js';

test('M0 的持久化面固定为九张表', () => {
  assert.equal(TABLES.length, 9);
  const names = TABLES.map((table) => getTableName(table)).sort();
  assert.deepEqual(names, [
    'automations',
    'memories',
    'messages',
    'run_events',
    'runs',
    'skills',
    'threads',
    'usage_ledger',
    'users',
  ]);
});

test('每张表都有主键和时间戳（事件表用业务时间 at）', () => {
  for (const table of TABLES) {
    const name = getTableName(table);
    const columns = Object.values(getTableColumns(table)) as Array<{ name?: string; primary?: boolean }>;

    assert.ok(
      columns.some((column) => column.primary === true),
      `${name} 缺主键`,
    );
    assert.ok(
      columns.some((column) => column.name === 'created_at' || column.name === 'at'),
      `${name} 缺时间戳`,
    );
  }
});
