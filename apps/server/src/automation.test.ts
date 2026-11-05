import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cronMatches, describeCron, selectDue, validateCron } from './automation.js';

const at = (iso: string): Date => new Date(iso);

test('cron 基本匹配：每天 08:00 只在 8 点整命中', () => {
  assert.equal(cronMatches('0 8 * * *', at('2026-11-05T08:00:00')), true);
  assert.equal(cronMatches('0 8 * * *', at('2026-11-05T08:01:00')), false);
  assert.equal(cronMatches('0 8 * * *', at('2026-11-05T20:00:00')), false);
});

test('步长、区间、列表都能用', () => {
  assert.equal(cronMatches('*/15 * * * *', at('2026-11-05T10:45:00')), true);
  assert.equal(cronMatches('*/15 * * * *', at('2026-11-05T10:46:00')), false);

  assert.equal(cronMatches('0 9-18 * * *', at('2026-11-05T13:00:00')), true);
  assert.equal(cronMatches('0 9-18 * * *', at('2026-11-05T19:00:00')), false);

  assert.equal(cronMatches('30 8,20 * * *', at('2026-11-05T20:30:00')), true);
  assert.equal(cronMatches('30 8,20 * * *', at('2026-11-05T20:31:00')), false);
});

test('周几匹配（周五 18:30）', () => {
  // 2026-11-06 是周五
  assert.equal(cronMatches('30 18 * * 5', at('2026-11-06T18:30:00')), true);
  assert.equal(cronMatches('30 18 * * 5', at('2026-11-05T18:30:00')), false);
});

test('坏表达式一律不命中，而不是抛错', () => {
  assert.equal(cronMatches('0 8 * *', at('2026-11-05T08:00:00')), false);
  assert.equal(cronMatches('', at('2026-11-05T08:00:00')), false);
  assert.equal(cronMatches('0 8 * * * *', at('2026-11-05T08:00:00')), false);
});

test('校验表达式，同时挡住越界取值', () => {
  assert.equal(validateCron('0 8 * * *'), true);
  assert.equal(validateCron('*/15 9-18 * * 1-5'), true);
  assert.equal(validateCron('0 25 * * *'), false, '小时不能超过 23');
  assert.equal(validateCron('60 * * * *'), false, '分钟不能超过 59');
  assert.equal(validateCron('0 8 * *'), false, '段数不对');
  assert.equal(validateCron('0 8 * * abc'), false);
});

test('describeCron 说人话', () => {
  assert.equal(describeCron('0 8 * * *'), '每天 08:00');
  assert.equal(describeCron('30 18 * * 5'), '每周五 18:30');
  assert.equal(describeCron('*/15 * * * *'), '每 15 分钟');
  assert.equal(describeCron('0 */2 * * *'), '每 2 小时的第 0 分');
  assert.equal(describeCron('0 9 1 * *'), '每月 1 日 09:00');
  assert.equal(describeCron('乱七八糟'), '乱七八糟');
});

test('selectDue 只挑启用、命中、且这一分钟没跑过的', () => {
  const now = at('2026-11-05T08:00:30');
  const base = { schedule: '0 8 * * *' };

  const picked = selectDue(
    [
      { id: 'a', ...base, enabled: true, lastRunAt: null },
      { id: 'b', ...base, enabled: false, lastRunAt: null },
      { id: 'c', ...base, enabled: true, lastRunAt: '2026-11-05T08:00:05' },
      { id: 'd', schedule: '0 9 * * *', enabled: true, lastRunAt: null },
    ],
    now,
  );

  assert.deepEqual(picked.map((item) => item.id), ['a']);
});

test('selectDue 容忍 tick 抖动，但不会同一分钟重复触发', () => {
  // 8:00 已经跑过（8:00:05），8:00:59 再来一次不该重复
  assert.deepEqual(
    selectDue([{ id: 'a', schedule: '0 8 * * *', enabled: true, lastRunAt: '2026-11-05T08:00:05' }], at('2026-11-05T08:00:59')),
    [],
  );
  // 下一分钟又该重跑吗？不，cron 只命中 8:00
  assert.deepEqual(
    selectDue([{ id: 'a', schedule: '0 8 * * *', enabled: true, lastRunAt: '2026-11-05T08:00:05' }], at('2026-11-05T08:01:10')),
    [],
  );
});
