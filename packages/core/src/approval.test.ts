import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApprovalGate } from './approval.js';

const request = (gate: ApprovalGate, callId = 'c1', timeoutMs?: number) =>
  gate.request({
    runId: 'run_1',
    callId,
    name: 'shell',
    risk: 'high',
    args: { command: 'pnpm build' },
    ...(timeoutMs ? { timeoutMs } : {}),
  });

test('允许之后 Promise 才 resolve，且只能被决定一次', async () => {
  const gate = new ApprovalGate();
  const pending = request(gate);

  assert.equal(gate.list('run_1').length, 1);
  assert.equal(gate.decide('run_1', 'c1', { decision: 'allow' }), true);
  assert.deepEqual(await pending, { decision: 'allow' });

  assert.equal(gate.decide('run_1', 'c1', { decision: 'allow' }), false, '第二次点击要落空');
  assert.equal(gate.size, 0);
});

test('拒绝会带上理由，工具不该执行', async () => {
  const gate = new ApprovalGate();
  const pending = request(gate);
  gate.decide('run_1', 'c1', { decision: 'deny', reason: '不想让它跑命令' });
  assert.deepEqual(await pending, { decision: 'deny', reason: '不想让它跑命令' });
});

test('等不到人就自动拒绝，运行不会烂在那里', async () => {
  const gate = new ApprovalGate({ timeoutMs: 120 });
  const decision = await request(gate, 'c9');
  assert.equal(decision.decision, 'deny');
  assert.match(decision.reason ?? '', /等不到审批/);
  assert.equal(gate.size, 0);
});

test('取消运行会把等待中的审批一起拒掉', async () => {
  const gate = new ApprovalGate();
  const first = request(gate, 'c1');
  const second = request(gate, 'c2');

  assert.equal(gate.cancelRun('run_1', '运行已取消'), 2);
  assert.equal((await first).decision, 'deny');
  assert.equal((await second).decision, 'deny');
  assert.equal(gate.size, 0);
});

test('审批列表按运行隔离，别的运行看不到', async () => {
  const gate = new ApprovalGate();
  const mine = request(gate, 'c1');

  const other = gate.request({ runId: 'run_2', callId: 'x1', name: 'write_file', risk: 'high', args: {} });
  assert.equal(gate.list('run_1').length, 1);
  assert.equal(gate.list('run_2').length, 1);

  gate.cancelRun('run_2');
  await other;
  assert.equal(gate.list('run_1').length, 1);
  gate.decide('run_1', 'c1', { decision: 'allow' });
  await mine;
});

test('pending 里有到期时间，界面能显示倒计时', () => {
  const gate = new ApprovalGate({ timeoutMs: 60_000 });
  const pending = request(gate, 'c1');
  const [entry] = gate.list('run_1');

  assert.ok(entry);
  assert.equal(entry.name, 'shell');
  assert.equal(entry.risk, 'high');
  assert.deepEqual(entry.args, { command: 'pnpm build' });
  const ttl = new Date(entry.expiresAt).getTime() - new Date(entry.requestedAt).getTime();
  assert.equal(ttl, 60_000);

  void pending;
  gate.cancelRun('run_1');
});
