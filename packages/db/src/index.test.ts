import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getTableColumns, getTableName } from 'drizzle-orm';

import { TABLES } from './schema.js';

test('持久化面固定为十四张表（九张基础表 + 知识图谱两张 + 应用、版本、键值）', () => {
  assert.equal(TABLES.length, 14);
  const names = TABLES.map((table) => getTableName(table)).sort();
  assert.deepEqual(names, [
    'app_kv',
    'app_versions',
    'apps',
    'automations',
    'kg_edges',
    'kg_nodes',
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
