#!/usr/bin/env node
/**
 * 任务卡执行器：把「给 agent 的活」和「怎么算做完」绑在一起。
 *
 *   node scripts/task-run.mjs <task-id> [--dry] [--no-approve]
 *
 * 做三件事：
 *   1. 把任务卡的 prompt + 验收标准 + 边界要求拼成一次运行，发给本地服务；
 *   2. 流里遇到工具审批就按卡里的 autoApprove 自动放行（--no-approve 关掉）；
 *   3. 运行结束后，自己跑卡里的 accept 命令 —— 过不过由我判断，不看它自己的测试有多宽松。
 *
 * 报告写到 tasks/reports/<id>-<时间>.json；有任何一项不达标就以 1 退出，能直接进 CI。
 */

import { exec } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TASKS_DIR = path.join(ROOT, 'tasks');
const REPORTS_DIR = path.join(TASKS_DIR, 'reports');

const id = process.argv[2];
const dry = process.argv.includes('--dry');
const noApprove = process.argv.includes('--no-approve');
/** 不跑 agent，只跑验收（改完代码想快速复检时用） */
const checkOnly = process.argv.includes('--check-only');
const SERVER = (process.env.RAKKO_SERVER ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

if (!id) {
  const files = (await readdir(TASKS_DIR)).filter((name) => name.endsWith('.task.json'));
  console.log('用法：node scripts/task-run.mjs <task-id> [--dry] [--no-approve]\n');
  console.log('可用任务卡：');
  for (const file of files) console.log('  ' + file.replace('.task.json', ''));
  process.exit(1);
}

const card = JSON.parse(await readFile(path.join(TASKS_DIR, `${id}.task.json`), 'utf8'));
const started = Date.now();

/** 把卡里的硬性要求写进提示，别指望人记得补 */
const composePrompt = (task) => {
  const lines = [task.prompt.trim(), '', '---', '## 验收标准（由执行器独立检查，不看你自己写的测试）'];
  for (const item of task.accept ?? []) {
    lines.push(`- ${item.name}：\`${item.cmd}\`${item.note ? `（${item.note}）` : ''}`);
  }
  if (task.boundaries?.concurrency) {
    lines.push(`- 并发边界：${[].concat(task.boundaries.concurrency).join(' / ')} 并发都要正确`);
  }
  if (task.boundaries?.mustNotChange?.length) {
    lines.push('- 不许改动的约束（执行器会检查，改了就算不通过）：');
    for (const item of task.boundaries.mustNotChange) {
      lines.push(typeof item === 'string' ? `  · ${item}` : `  · ${item.file} 里必须保留：${item.contains}`);
    }
  }
  lines.push('', '做完前先自己按上面的命令跑一遍；跑不过就继续修，不要说完成了。');
  return lines.join('\n');
};

const prompt = composePrompt(card);

if (dry) {
  console.log(prompt);
  process.exit(0);
}

if (checkOnly) {
  process.exit(await runAcceptance({ state: 'succeeded', runId: null, threadId: null, calls: [], answer: null }));
}

const api = async (p, options = {}) => {
  const response = await fetch(SERVER + p, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(body?.message ?? `请求失败 ${response.status}`);
  return body;
};

function runShell(command) {
  return new Promise((resolve) => {
    exec(command, { cwd: ROOT, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        output: `${stdout}${stderr}`.trim(),
      });
    });
  });
}

console.log(`任务卡：${card.id} · ${card.title}`);
console.log(`服务：${SERVER}`);

const health = await api('/health').catch(() => null);
if (!health) {
  console.error('连不上服务端。先起服务：node --env-file=.env apps/server/dist/index.js');
  process.exit(1);
}

const thread = await api('/v1/threads', { method: 'POST', body: JSON.stringify({ title: `task · ${card.id}` }) });
const run = await api('/v1/runs', { method: 'POST', body: JSON.stringify({ threadId: thread.id, prompt }) });
console.log(`运行：${run.id}（模型 ${run.model}）\n`);

let finalState = null;
const toolCalls = [];
const controller = new AbortController();
const hardStop = setTimeout(() => controller.abort(), 20 * 60_000);

try {
  const response = await fetch(`${SERVER}/v1/runs/${run.id}/events`, { signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const line = part.split('\n').find((row) => row.startsWith('data: '));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      const at = ((Date.now() - started) / 1000).toFixed(1);

      if (event.type === 'run.tool_call') {
        toolCalls.push(event.name);
        console.log(`[${at}s] → ${event.name}`);
      } else if (event.type === 'run.tool_result') {
        console.log(`[${at}s] ← ${event.ok ? 'ok' : 'fail'} ${String(event.output ?? '').split('\n')[0].slice(0, 120)}`);
      } else if (event.type === 'run.approval_requested') {
        const allowed = !noApprove && (card.autoApprove ?? []).includes(event.name);
        console.log(`[${at}s] ? 审批 ${event.name} → ${allowed ? '自动允许' : '拒绝（不在 autoApprove 里）'}`);
        await api(`/v1/runs/${run.id}/approvals/${event.callId}`, {
          method: 'POST',
          body: JSON.stringify({ decision: allowed ? 'allow' : 'deny', scope: 'once' }),
        });
      } else if (event.type === 'run.done') {
        finalState = event.state;
        clearTimeout(hardStop);
        controller.abort();
      }
    }
    if (finalState) break;
  }
} catch {
  /* abort 属正常收尾 */
} finally {
  clearTimeout(hardStop);
}

const runRecord = await api(`/v1/runs/${run.id}`);
const messages = await api(`/v1/threads/${thread.id}/messages`);
const answer = messages.items.filter((item) => item.role === 'assistant' && item.kind === 'text').at(-1);

console.log(`\n运行结束：${runRecord.state}${runRecord.error ? `（${runRecord.error}）` : ''} · ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (answer?.text) console.log(`agent 说：${answer.text.replace(/\n+/g, ' ').slice(0, 300)}\n`);

/* ---- 独立验收（agent 跑完、或 --check-only 直接跑）---- */
async function runAcceptance({ state, error = null, runId = null, threadId = null, calls = [], answer: answerText = null }) {
  console.log('验收（执行器自己跑，不看 agent 的测试）');
  const results = [];

  for (const item of card.accept ?? []) {
    const { code, output } = await runShell(item.cmd);
    const ok = code === (item.expectExitCode ?? 0);
    results.push({ name: item.name, cmd: item.cmd, exitCode: code, ok, tail: output.split('\n').slice(-6).join('\n') });
    console.log(`${ok ? '✓' : '✗'} ${item.name}  [exit ${code}]`);
    if (!ok) console.log(output.split('\n').slice(-12).map((line) => '    ' + line).join('\n'));
  }

  /* ---- 不许动的东西还在不在 ---- */
  const guards = [];
  for (const guard of card.boundaries?.mustNotChange ?? []) {
    if (typeof guard !== 'object' || !guard.file) continue;
    let text = '';
    try {
      text = await readFile(path.join(ROOT, guard.file), 'utf8');
    } catch {
      text = '';
    }
    const ok = text.includes(guard.contains);
    guards.push({ ...guard, ok });
    console.log(`${ok ? '✓' : '✗'} 未改动：${guard.file} 仍包含「${guard.contains}」`);
  }

  const passed =
    results.every((item) => item.ok) &&
    guards.every((item) => item.ok) &&
    state === 'succeeded' &&
    (calls.length > 0 || runId === null);

  await mkdir(REPORTS_DIR, { recursive: true });
  const report = {
    task: card.id,
    title: card.title,
    at: new Date().toISOString(),
    runId,
    threadId,
    state,
    error,
    durationMs: Date.now() - started,
    toolCalls: calls,
    answer: answerText,
    results,
    guards,
    passed,
  };
  const reportPath = path.join(REPORTS_DIR, `${card.id}-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log(`\n${passed ? '通过' : '不通过'} · 报告 ${path.relative(ROOT, reportPath)}`);
  return passed ? 0 : 1;
}

process.exit(await runAcceptance({ state: runRecord.state, error: runRecord.error, runId: run.id, threadId: thread.id, calls: toolCalls, answer: answer?.text ?? null }));
