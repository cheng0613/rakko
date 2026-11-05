import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, RunEvent } from '@rakko/protocol';

import { summarizeTrace } from './trace.js';

const run: Run = {
  id: 'run-1',
  threadId: 'thread-1',
  state: 'failed',
  model: 'deepseek-v4-pro',
  prompt: '改个 bug',
  error: '步数用完了',
  createdAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:12.000Z',
};

const at = (seconds: number) => `2026-01-01T00:00:${String(seconds).padStart(2, '0')}.000Z`;

test('体检报告：耗时、首字、工具成败、降级、审批、错误都折得出来', () => {
  const events: RunEvent[] = [
    { type: 'run.started', runId: 'run-1', at: at(0) },
    { type: 'run.tool_call', runId: 'run-1', at: at(1), callId: 'c1', name: 'read_file', args: {} },
    { type: 'run.tool_result', runId: 'run-1', at: at(3), callId: 'c1', ok: true, output: '...' },
    { type: 'run.tool_call', runId: 'run-1', at: at(4), callId: 'c2', name: 'shell', args: {} },
    { type: 'run.approval_requested', runId: 'run-1', at: at(4), callId: 'c2', name: 'shell', risk: 'high', args: {} },
    { type: 'run.approval_decided', runId: 'run-1', at: at(5), callId: 'c2', decision: 'deny' },
    { type: 'run.tool_result', runId: 'run-1', at: at(5), callId: 'c2', ok: false, output: '被拒绝' },
    { type: 'run.reasoning', runId: 'run-1', at: at(6), text: '先看看文件' },
    { type: 'run.fallback', runId: 'run-1', at: at(6), from: 'deepseek-v4-pro', to: 'deepseek-flash', reason: '超时' },
    { type: 'run.delta', runId: 'run-1', at: at(7), text: '我先看看' },
    { type: 'run.error', runId: 'run-1', at: at(12), message: '步数用完了' },
  ];

  const summary = summarizeTrace(run, events);

  assert.equal(summary.state, 'failed');
  assert.equal(summary.durationMs, 12_000);
  assert.equal(summary.firstTokenMs, 7_000, '第一个字在第 7 秒');
  assert.equal(summary.firstOutputMs, 6_000, '但第 6 秒就开始思考了');
  assert.equal(summary.toolCalls, 2);
  assert.equal(summary.toolFailures, 1);
  assert.equal(summary.fallbacks, 1);
  assert.equal(summary.approvals, 1);
  assert.equal(summary.denials, 1);
  assert.deepEqual(summary.errors, ['步数用完了']);
  assert.deepEqual(summary.tools, [
    { name: 'read_file', calls: 1, failures: 0, ms: 2_000 },
    { name: 'shell', calls: 1, failures: 1, ms: 1_000 },
  ]);
});

test('体检报告：没有结果就结束的工具算失败，悬着的时间也算进去', () => {
  const interrupted: Run = { ...run, state: 'canceled', error: null };
  const events: RunEvent[] = [
    { type: 'run.started', runId: 'run-1', at: at(0) },
    { type: 'run.tool_call', runId: 'run-1', at: at(2), callId: 'c1', name: 'http', args: {} },
    { type: 'run.state', runId: 'run-1', at: at(8), state: 'canceled' },
  ];

  const summary = summarizeTrace(interrupted, events);

  assert.equal(summary.toolCalls, 1);
  assert.equal(summary.toolFailures, 1, '半路被取消的工具不能算成功');
  assert.equal(summary.tools[0]?.ms, 6_000);
  assert.equal(summary.firstTokenMs, null, '一个字都没出');
  assert.deepEqual(summary.errors, [], 'run.error 为空就不该造一条');
});

test('体检报告：空运行也不炸', () => {
  const summary = summarizeTrace({ ...run, state: 'queued', error: null, finishedAt: null }, []);
  assert.equal(summary.durationMs, 0);
  assert.equal(summary.toolCalls, 0);
  assert.deepEqual(summary.tools, []);
  assert.deepEqual(summary.errors, []);
});
