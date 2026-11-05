import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createSecondToolset } from './network.js';
import { ToolRegistry } from '../tools.js';

const allow = async () => ({ decision: 'allow' as const });

const setup = async (http: { fetchImpl?: typeof fetch; allowPrivate?: boolean } = {}) => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'rakko-net-'));
  await writeFile(path.join(workspace, 'a.ts'), 'const todo = "TODO: 接上 grep";\nconst other = 1;\n');
  await writeFile(path.join(workspace, 'b.md'), '# TODO 清单\n第二个 TODO\n');
  await mkdir(path.join(workspace, 'node_modules', 'x'), { recursive: true });
  await writeFile(path.join(workspace, 'node_modules', 'x', 'c.ts'), 'TODO 不该被搜到\n');

  const registry = new ToolRegistry({ workspace });
  for (const tool of createSecondToolset({ workspace, http })) registry.register(tool);
  return { registry, workspace };
};

test('grep 能搜到内容，并跳过 node_modules', async () => {
  const { registry } = await setup();
  const result = await registry.execute({ id: 'c1', name: 'grep', args: { pattern: 'TODO' } }, { approve: allow });

  assert.equal(result.ok, true);
  assert.match(result.output, /a\.ts:1: .*TODO/);
  assert.match(result.output, /b\.md:1: # TODO 清单/);
  assert.doesNotMatch(result.output, /node_modules/);
});

test('grep 支持 glob 过滤与大小写', async () => {
  const { registry } = await setup();
  const onlyTs = await registry.execute({ id: 'c1', name: 'grep', args: { pattern: 'todo', glob: '*.ts', ignoreCase: true } }, { approve: allow });
  assert.match(onlyTs.output, /a\.ts:1/);
  assert.doesNotMatch(onlyTs.output, /b\.md/);

  // a.ts 里是小写 todo，b.md 里是大写 TODO
  const caseSensitive = await registry.execute({ id: 'c2', name: 'grep', args: { pattern: 'todo' } }, { approve: allow });
  assert.match(caseSensitive.output, /a.ts:1/);
  assert.doesNotMatch(caseSensitive.output, /b.md/);
});

test('grep 正则有错时说清楚，而不是崩掉', async () => {
  const { registry } = await setup();
  const result = await registry.execute({ id: 'c1', name: 'grep', args: { pattern: '([' } }, { approve: allow });
  assert.equal(result.ok, false);
  assert.match(result.output, /正则写错了/);
});

test('apply_patch 精确替换，且拒绝歧义与找不到', async () => {
  const { registry, workspace } = await setup();

  const ok = await registry.execute(
    { id: 'c1', name: 'apply_patch', args: { path: 'a.ts', hunks: [{ old: 'const other = 1;', new: 'const other = 2;' }] } },
    { approve: allow },
  );
  assert.equal(ok.ok, true);
  assert.match(ok.output, /1 处改动/);
  assert.match(await readFile(path.join(workspace, 'a.ts'), 'utf8'), /const other = 2;/);

  const ambiguous = await registry.execute(
    { id: 'c2', name: 'apply_patch', args: { path: 'b.md', hunks: [{ old: 'TODO', new: 'DONE' }] } },
    { approve: allow },
  );
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.output, /出现了 2 次/);

  const missing = await registry.execute(
    { id: 'c3', name: 'apply_patch', args: { path: 'b.md', hunks: [{ old: '不存在的一段', new: 'x' }] } },
    { approve: allow },
  );
  assert.equal(missing.ok, false);
  assert.match(missing.output, /找不到这段原文/);
});

test('apply_patch 拒绝越界路径', async () => {
  const { registry } = await setup();
  const result = await registry.execute(
    { id: 'c1', name: 'apply_patch', args: { path: '../../etc/hosts', hunks: [{ old: 'a', new: 'b' }] } },
    { approve: allow },
  );
  assert.equal(result.ok, false);
  assert.match(result.output, /路径越界/);
});

test('http 默认不许打内网地址', async () => {
  const { registry } = await setup();
  const result = await registry.execute({ id: 'c1', name: 'http', args: { url: 'http://127.0.0.1:8787/health' } }, { approve: allow });
  assert.equal(result.ok, false);
  assert.match(result.output, /内网/);
});

test('http 打外网时带上状态码与响应体', async () => {
  const { registry } = await setup({
    fetchImpl: (async () =>
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
  });
  const result = await registry.execute({ id: 'c1', name: 'http', args: { url: 'https://example.com/api' } }, { approve: allow });
  assert.equal(result.ok, true);
  assert.match(result.output, /200/);
  assert.match(result.output, /"ok":true/);
});

test('http 与 apply_patch 都要审批：拒绝就不发请求', async () => {
  let called = false;
  const { registry } = await setup({
    fetchImpl: (async () => {
      called = true;
      return new Response('x');
    }) as unknown as typeof fetch,
  });

  const denied = await registry.execute(
    { id: 'c1', name: 'http', args: { url: 'https://example.com' } },
    { approve: async () => ({ decision: 'deny' as const }) },
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, true);
  assert.equal(called, false);
});

test('已授权的工具不再弹审批', async () => {
  const { registry } = await setup();
  let asked = 0;
  const result = await registry.execute(
    { id: 'c1', name: 'apply_patch', args: { path: 'a.ts', hunks: [{ old: 'const other = 1;', new: 'const other = 3;' }] } },
    { approve: async () => { asked += 1; return { decision: 'allow' as const }; }, isGranted: () => true },
  );
  assert.equal(result.ok, true);
  assert.equal(asked, 0);
});
