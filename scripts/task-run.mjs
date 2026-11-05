#!/usr/bin/env node
/**
 * 任务卡执行器：把「给 agent 的活」和「怎么算做完」绑在一起。
 *
 *   node scripts/task-run.mjs <task-id> [--dry] [--check-only] [--update-snapshots] [--no-approve]
 *
 * 做四件事：
 *   1. 把卡里的 prompt + 验收标准 + 边界要求拼成一次运行，发给本地服务；
 *   2. 流里遇到工具审批就按卡里的 autoApprove 自动放行；
 *   3. 运行结束后自己跑验收：accept 命令 + mustNotChange 文本守卫 + 行为快照；
 *   4. 验收脚本放在工作区外的 acceptance 目录里 —— agent 读不到，没法照着改代码。
 *
 * 报告写到 <acceptance>/reports/<id>-<时间>.json；任何一项不达标就以 1 退出。
 */

import { exec } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TASKS_DIR = path.join(ROOT, 'tasks');
/** 验收资产放在工作区外：agent 的文件工具锁在工作区，够不到这里 */
const VAULT = process.env.RAKKO_ACCEPTANCE_DIR ?? path.join(homedir(), '.rakko-acceptance');
const CHECK_DIR = path.join(VAULT, 'checks');
const SNAPSHOT_DIR = path.join(VAULT, 'snapshots');
const REPORT_DIR = path.join(VAULT, 'reports');

const id = process.argv[2];
const dry = process.argv.includes('--dry');
const noApprove = process.argv.includes('--no-approve');
const checkOnly = process.argv.includes('--check-only');
const updateSnapshots = process.argv.includes('--update-snapshots');
const SERVER = (process.env.RAKKO_SERVER ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

if (!id) {
  const files = (await readdir(TASKS_DIR).catch(() => [])).filter((name) => name.endsWith('.task.json'));
  console.log('用法：node scripts/task-run.mjs <task-id> [--dry] [--check-only] [--update-snapshots]\n');
  console.log(`验收资产：${VAULT}`);
  console.log('可用任务卡：');
  for (const file of files) console.log('  ' + file.replace('.task.json', ''));
  process.exit(1);
}

const card = JSON.parse(await readFile(path.join(TASKS_DIR, `${id}.task.json`), 'utf8'));
const started = Date.now();

/** 把卡里的硬性要求写进提示，别指望人记得补 */
function composePrompt(task) {
  const lines = [task.prompt.trim(), '', '---', '## 验收标准（执行器在工作区外自己跑，不看你自己写的测试）'];
  for (const item of task.accept ?? []) {
    const where = item.check ? `验收脚本 ${item.check}` : `\`${item.cmd}\``;
    lines.push(`- ${item.name}：${where}${item.note ? `（${item.note}）` : ''}`);
  }
  if (task.boundaries?.concurrency) {
    lines.push(`- 并发边界：${[].concat(task.boundaries.concurrency).join(' / ')} 并发都要正确`);
  }
  if (task.boundaries?.snapshots?.length) {
    lines.push('- 行为快照：这些函数的输入输出会被比对，行为变了就算不达标：');
    for (const spec of task.boundaries.snapshots) lines.push(`  · ${spec.name}（${spec.module} 的 ${spec.export}）`);
  }
  if (task.boundaries?.mustNotChange?.length) {
    lines.push('- 不许改动的约束（执行器会检查，改了就算不通过）：');
    for (const item of task.boundaries.mustNotChange) {
      lines.push(typeof item === 'string' ? `  · ${item}` : `  · ${item.file} 里必须保留：${item.contains}`);
    }
  }
  lines.push('', '做完前先自己按上面的命令跑一遍；跑不过就继续修，不要说完成了。');
  return lines.join('\n');
}

const prompt = composePrompt(card);

if (dry) {
  console.log(prompt);
  process.exit(0);
}

function runShell(command, cwd = ROOT) {
  return new Promise((resolve) => {
    exec(
      command,
      // RAKKO_ROOT 给工作区外的验收脚本用：它们靠它找到仓库的 dist
      { cwd, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, RAKKO_ROOT: ROOT } },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          output: `${stdout}${stderr}`.trim(),
        });
      },
    );
  });
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

/* ---------------- 独立的验收：命令 / 文本守卫 / 行为快照 ---------------- */

async function runAcceptCommands() {
  const results = [];
  for (const item of card.accept ?? []) {
    let code = 0;
    let output = '';

    if (item.check) {
      // 验收脚本在工作区外；先确认它真的在那儿，别让「文件丢了」变成「静默通过」
      const scriptPath = path.join(CHECK_DIR, item.check);
      try {
        await readFile(scriptPath, 'utf8');
      } catch {
        results.push({ name: item.name, check: item.check, exitCode: -1, ok: false, tail: `找不到验收脚本：${scriptPath}` });
        console.log(`✗ ${item.name}  [验收脚本不存在]`);
        console.log(`    ${scriptPath}`);
        continue;
      }
      ({ code, output } = await runShell(`node "${scriptPath}"`, ROOT));
    } else if (item.cmd) {
      ({ code, output } = await runShell(item.cmd, ROOT));
    } else {
      continue;
    }

    const ok = code === (item.expectExitCode ?? 0);
    results.push({ ...item, exitCode: code, ok, tail: output.split('\n').slice(-8).join('\n') });
    console.log(`${ok ? '✓' : '✗'} ${item.name}  [exit ${code}]`);
    if (!ok) console.log(output.split('\n').slice(-12).map((line) => '    ' + line).join('\n'));
  }
  return results;
}

async function runGuards() {
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
  return guards;
}

/** 行为快照：调用真实导出，比对输入输出。文本没变但行为变了，这里会红 */
async function runSnapshots() {
  const specs = card.boundaries?.snapshots ?? [];
  if (specs.length === 0) return [];

  await mkdir(SNAPSHOT_DIR, { recursive: true });
  const file = path.join(SNAPSHOT_DIR, `${card.id}.json`);
  let baseline = {};
  if (!updateSnapshots) {
    try {
      baseline = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      baseline = {};
    }
  }

  const results = [];
  const next = {};

  for (const spec of specs) {
    let fn = null;
    let loadError = null;
    try {
      const mod = await import(spec.module);
      fn = mod[spec.export];
    } catch (error) {
      loadError = error?.message ?? String(error);
    }
    if (typeof fn !== 'function') {
      results.push({ name: spec.name, ok: false, reason: loadError ?? `没有导出 ${spec.export}` });
      console.log(`✗ 快照 ${spec.name}：无法加载 ${spec.module} 的 ${spec.export}`);
      continue;
    }

    const cases = [];
    for (const item of spec.cases ?? []) {
      let result;
      let error = null;
      try {
        result = await fn(...(item.args ?? []));
      } catch (caught) {
        error = caught?.message ?? String(caught);
      }
      cases.push({ args: item.args ?? [], result: result === undefined ? null : result, error });
    }

    next[spec.name] = { module: spec.module, export: spec.export, cases };
    const expected = baseline[spec.name]?.cases;
    const ok = updateSnapshots || JSON.stringify(expected) === JSON.stringify(cases);
    results.push({ name: spec.name, ok, cases, expected });

    console.log(`${ok ? '✓' : '✗'} 快照：${spec.name}${updateSnapshots ? '（已按当前行为更新基线）' : ''}`);
    if (!ok && expected) {
      for (const [index, item] of cases.entries()) {
        const before = expected[index];
        if (JSON.stringify(before) === JSON.stringify(item)) continue;
        console.log(`    第 ${index + 1} 例变了：`);
        console.log(`      之前：${JSON.stringify(before)}`);
        console.log(`      现在：${JSON.stringify(item)}`);
      }
    }
    if (!ok && !expected) console.log('    没有基线：先跑一次 --update-snapshots');
  }

  if (updateSnapshots) {
    await writeFile(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
    console.log(`\n基线已写入 ${file}`);
  }
  return results;
}

/* ---------------- 验收总装 ---------------- */

async function runAcceptance({ state, error = null, runId = null, threadId = null, calls = [], answer: answerText = null }) {
  console.log('验收（执行器自己跑，不看 agent 的测试）');
  const results = await runAcceptCommands();
  const guards = await runGuards();
  const snapshots = await runSnapshots();

  const passed =
    results.every((item) => item.ok) &&
    guards.every((item) => item.ok) &&
    snapshots.every((item) => item.ok) &&
    state === 'succeeded' &&
    (calls.length > 0 || runId === null);

  await mkdir(REPORT_DIR, { recursive: true });
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
    snapshots,
    passed,
  };
  const reportPath = path.join(REPORT_DIR, `${card.id}-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log(`\n${passed ? '通过' : '不通过'} · 报告 ${reportPath}`);
  return passed ? 0 : 1;
}

if (checkOnly || updateSnapshots) {
  process.exit(await runAcceptance({ state: 'succeeded', runId: null, threadId: null, calls: [], answer: null }));
}

/* ---------------- 跑 agent ---------------- */

console.log(`任务卡：${card.id} · ${card.title}`);
console.log(`服务：${SERVER}`);
console.log(`验收资产：${VAULT}\n`);

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

process.exit(
  await runAcceptance({
    state: runRecord.state,
    error: runRecord.error,
    runId: run.id,
    threadId: thread.id,
    calls: toolCalls,
    answer: answer?.text ?? null,
  }),
);
