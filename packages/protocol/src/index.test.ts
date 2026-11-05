import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createRunInput,
  parseRunEvent,
  RUN_STATES,
  runEventSchema,
  serializeRunEvent,
  TERMINAL_STATES,
  usageSchema,
} from './index.js';

const base = { runId: 'run_1', at: '2026-11-05T09:00:00.000Z' };

test('每种运行事件都能往返序列化', () => {
  const events = [
    { type: 'run.started' as const, ...base },
    { type: 'run.delta' as const, ...base, text: '海獭在砸壳' },
    { type: 'run.reasoning' as const, ...base, text: '先看看现在是什么状态' },
    { type: 'run.fallback' as const, ...base, from: 'deepseek-v4-pro', to: 'deepseek-flash', reason: '接口返回 503' },
    { type: 'run.tool_call' as const, ...base, callId: 'c1', name: 'shell', args: { cmd: 'ls' } },
    { type: 'run.tool_result' as const, ...base, callId: 'c1', ok: true, output: 'ok' },
    { type: 'run.state' as const, ...base, state: 'running' as const },
    { type: 'run.error' as const, ...base, message: '上游超时', code: 'upstream_timeout' },
    { type: 'run.done' as const, ...base, state: 'succeeded' as const },
  ];

  for (const event of events) {
    const round = parseRunEvent(JSON.parse(serializeRunEvent(event)));
    assert.equal(round.ok, true, `事件 ${event.type} 往返失败`);
  }
});

test('坏事件被单条丢弃，而不是让整条流失败', () => {
  const bad = parseRunEvent({ type: 'run.exploded', ...base });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.reason, /type/);
});

test('事件类型封闭：不接受未声明的 type', () => {
  const result = runEventSchema.safeParse({ type: 'run.delta', runId: 'r', at: 'x', text: 1 });
  assert.equal(result.success, false);
});

test('终态必须是状态枚举的子集', () => {
  for (const state of TERMINAL_STATES) {
    assert.ok(RUN_STATES.includes(state));
  }
  assert.equal(TERMINAL_STATES.length, 3);
});

test('运行输入拒绝空提示词', () => {
  assert.equal(createRunInput.safeParse({ threadId: 't1', prompt: '' }).success, false);
  assert.equal(createRunInput.safeParse({ threadId: 't1', prompt: '  ' }).success, true, '纯空格暂不拦截，交给上游 trim');
  assert.equal(createRunInput.safeParse({ threadId: 't1', prompt: '帮我看下构建' }).success, true);
});

test('配额计数不能出现负数', () => {
  const ok = usageSchema.safeParse({
    plan: 'Pro',
    limit: 120,
    used: 62,
    remaining: 58,
    periodStart: '2026-11-01T00:00:00.000Z',
    degradeOnExceed: true,
  });
  assert.equal(ok.success, true);

  const bad = usageSchema.safeParse({
    plan: 'Pro',
    limit: 120,
    used: -1,
    remaining: 121,
    periodStart: '2026-11-01T00:00:00.000Z',
    degradeOnExceed: true,
  });
  assert.equal(bad.success, false);
});
