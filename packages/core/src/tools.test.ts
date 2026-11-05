import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createBuiltinTools } from './tools/builtin.js';
import { ToolRegistry } from './tools.js';

const makeRegistry = async (): Promise<{ registry: ToolRegistry; workspace: string }> => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'rakko-tools-'));
  const registry = new ToolRegistry({ workspace });
  for (const tool of createBuiltinTools({ workspace, shellTimeoutMs: 10_000 })) registry.register(tool);
  return { registry, workspace };
};

const allow = async () => ({ decision: 'allow' as const });
const deny = async () => ({ decision: 'deny' as const });

test('read_file 读得到工作区里的文件', async () => {
  const { registry, workspace } = await makeRegistry();
  await writeFile(path.join(workspace, 'a.txt'), '海獭抱石头');

  const result = await registry.execute({ id: 'c1', name: 'read_file', args: { path: 'a.txt' } }, { approve: allow });
  assert.equal(result.ok, true);
  assert.equal(result.output, '海獭抱石头');
});

test('路径越界一律拒绝，连读都不给读', async () => {
  const { registry } = await makeRegistry();
  const result = await registry.execute({ id: 'c1', name: 'read_file', args: { path: '../../etc/passwd' } }, { approve: allow });
  assert.equal(result.ok, false);
  assert.match(result.output, /路径越界/);
});

test('未知工具与参数不合法都返回可解释的文本，而不是崩掉', async () => {
  const { registry } = await makeRegistry();

  const unknown = await registry.execute({ id: 'c1', name: 'nope', args: {} }, { approve: allow });
  assert.equal(unknown.ok, false);
  assert.match(unknown.output, /没有名为 nope 的工具/);

  const badArgs = await registry.execute({ id: 'c2', name: 'read_file', args: { path: 42 } }, { approve: allow });
  assert.equal(badArgs.ok, false);
  assert.match(badArgs.output, /参数不合法/);
});

test('write_file 必须过审批：拒绝就不落盘', async () => {
  const { registry, workspace } = await makeRegistry();
  const result = await registry.execute(
    { id: 'c1', name: 'write_file', args: { path: 'note.txt', content: 'x' } },
    { approve: deny },
  );

  assert.equal(result.ok, false);
  assert.equal(result.denied, true);
  assert.equal(existsSync(path.join(workspace, 'note.txt')), false);
});

test('write_file 允许后才写，并自动建目录', async () => {
  const { registry, workspace } = await makeRegistry();
  const result = await registry.execute(
    { id: 'c1', name: 'write_file', args: { path: 'deep/dir/note.txt', content: '写进去了' } },
    { approve: allow },
  );

  assert.equal(result.ok, true);
  assert.equal(await readFile(path.join(workspace, 'deep/dir/note.txt'), 'utf8'), '写进去了');
});

test('shell 能跑，且以工作区为 cwd', async () => {
  const { registry, workspace } = await makeRegistry();
  await writeFile(path.join(workspace, 'marker.txt'), 'here');

  const result = await registry.execute(
    { id: 'c1', name: 'shell', args: { command: 'node -e "console.log(process.cwd())"' } },
    { approve: allow },
  );
  assert.equal(result.ok, true);
  assert.ok(result.output.includes('rakko-tools-'));
});

test('自毁类命令连审批都不给', async () => {
  const { registry } = await makeRegistry();
  const result = await registry.execute({ id: 'c1', name: 'shell', args: { command: 'rm -rf /' } }, { approve: allow });
  assert.equal(result.ok, false);
  assert.match(result.output, /硬规则/);
});

test('命令失败时把退出码与输出一起交回模型', async () => {
  const { registry } = await makeRegistry();
  const result = await registry.execute(
    { id: 'c1', name: 'shell', args: { command: 'node -e "console.error(\'boom\'); process.exit(3)"' } },
    { approve: allow },
  );
  assert.equal(result.ok, false);
  assert.match(result.output, /退出码 3/);
  assert.match(result.output, /boom/);
});

test('发给模型的工具描述是 JSON Schema，不用手写两份', async () => {
  const { registry } = await makeRegistry();
  const definitions = registry.definitions();
  assert.equal(definitions.length, 5, '4 个文件工具 + render_ui');

  const readFile = definitions.find((tool) => tool.name === 'read_file');
  assert.ok(readFile);
  const schema = readFile.parameters as { type: string; required: string[]; properties: Record<string, unknown> };
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['path']);
  assert.ok(schema.properties.path);
});
