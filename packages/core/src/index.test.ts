import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CircuitBreaker } from './circuit-breaker.js';
import {
  currentPeriod,
  decideQuota,
  periodStart,
  planLimit,
  remainingQuota,
  shouldChargeRun,
} from './quota.js';
import { assertTransition, canTransition, IllegalTransition, isTerminal } from './run-machine.js';
import { FakeProvider } from './provider.js';

test('连续失败到阈值开门，冷却后只放一个探针', () => {
  let clock = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000, now: () => clock });

  assert.equal(breaker.canPass(), true);
  for (let i = 0; i < 3; i += 1) breaker.recordFailure();
  assert.equal(breaker.getState(), 'open');
  assert.equal(breaker.canPass(), false);

  clock = 1_000;
  assert.equal(breaker.getState(), 'half_open');
  assert.equal(breaker.canPass(), true, '第一个探针放行');
  assert.equal(breaker.canPass(), false, '探针在飞时不再放行');

  breaker.recordSuccess();
  assert.equal(breaker.getState(), 'closed');
  assert.equal(breaker.canPass(), true);
});

test('探针失败立刻回到开门，不留半开缝隙', () => {
  let clock = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500, now: () => clock });
  breaker.recordFailure();
  assert.equal(breaker.getState(), 'open');

  clock = 600;
  assert.equal(breaker.canPass(), true);
  breaker.recordFailure();
  assert.equal(breaker.getState(), 'open');
  assert.equal(breaker.canPass(), false);
});

test('配额按次数计，用超了按设置降级或拦截', () => {
  assert.deepEqual(decideQuota({ limit: 120, used: 62, degradeOnExceed: true }), {
    kind: 'allow',
    remaining: 58,
  });
  assert.equal(remainingQuota({ limit: 120, used: 62, degradeOnExceed: true }), 58);

  assert.equal(decideQuota({ limit: 120, used: 120, degradeOnExceed: true }).kind, 'degrade');
  assert.equal(decideQuota({ limit: 120, used: 130, degradeOnExceed: false }).kind, 'block');
});

test('计划上限只认三档，未知计划落到 free', () => {
  assert.equal(planLimit('pro'), 120);
  assert.equal(planLimit('free'), 30);
  assert.equal(planLimit('team'), 600);
  assert.equal(planLimit('enterprise-whatever'), 30);
});

test('周期用 UTC，跨年不错月', () => {
  assert.equal(currentPeriod(new Date('2026-11-05T01:00:00Z')), '2026-11');
  assert.equal(currentPeriod(new Date('2026-01-01T00:00:00Z')), '2026-01');
  assert.equal(periodStart(new Date('2026-11-05T01:00:00Z')), '2026-11-01T00:00:00.000Z');
});

test('取消的运行不扣次数', () => {
  assert.equal(shouldChargeRun('succeeded'), true);
  assert.equal(shouldChargeRun('failed'), true);
  assert.equal(shouldChargeRun('canceled'), false);
});

test('状态机拒绝越过终态', () => {
  assert.equal(canTransition('queued', 'running'), true);
  assert.equal(canTransition('running', 'waiting_approval'), true);
  assert.equal(canTransition('waiting_approval', 'running'), true);
  assert.equal(canTransition('succeeded', 'running'), false);
  assert.equal(isTerminal('failed'), true);

  assert.throws(() => assertTransition('succeeded', 'running'), IllegalTransition);
});

test('假 provider 的流以 done 收尾', async () => {
  const provider = new FakeProvider();
  const chunks = [];
  for await (const chunk of provider.stream({ runId: 'r1', messages: [{ role: 'user', content: '看看构建' }], model: 'fast' })) {
    chunks.push(chunk);
  }
  assert.equal(chunks.at(-1)?.kind, 'done');
  assert.ok(chunks.length >= 3);
});
