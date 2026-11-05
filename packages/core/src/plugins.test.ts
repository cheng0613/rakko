import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadToolPlugins } from './plugins.js';
import { ToolRegistry } from './tools.js';

const makeDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'rakko-plugins-'));

const allow = async () => ({ decision: 'allow' as const });

test('插件目录里的工具会被加载，参数用 JSON Schema 透传', async () => {
  const dir = await makeDir();
  await writeFile(
    path.join(dir, 'clock.mjs'),
    [
      "export const name = 'clock';",
      "export const description = '返回当前时间';",
      "export const risk = 'low';",
      'export const requiresApproval = false;',
      "export const parameters = { type: 'object', properties: { format: { type: 'string' } } };",
      'export async function run(args) { return `格式化=${args.format ?? "默认"}`; }',
    ].join('\n'),
    'utf8',
  );

  const { tools, errors } = await loadToolPlugins(dir);
  assert.equal(errors.length, 0);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, 'clock');
  assert.equal(tools[0]?.risk, 'low');
  assert.equal(tools[0]?.requiresApproval, false);

  const registry = new ToolRegistry({ workspace: dir });
  for (const tool of tools) registry.register(tool);

  const definition = registry.definitions()[0];
  assert.deepEqual(definition?.parameters, { type: 'object', properties: { format: { type: 'string' } } });

  const result = await registry.execute({ id: 'c1', name: 'clock', args: { format: 'iso' } }, { approve: allow });
  assert.equal(result.ok, true);
  assert.equal(result.output, '格式化=iso');
});

test('插件默认要审批，未授权时不会执行', async () => {
  const dir = await makeDir();
  await writeFile(
    path.join(dir, 'danger.mjs'),
    [
      "export const name = 'danger';",
      "export const description = '默认要审批的插件';",
      'export async function run() { return "执行了"; }',
    ].join('\n'),
    'utf8',
  );

  const { tools } = await loadToolPlugins(dir);
  const registry = new ToolRegistry({ workspace: dir });
  for (const tool of tools) registry.register(tool);

  const denied = await registry.execute(
    { id: 'c1', name: 'danger', args: {} },
    { approve: async () => ({ decision: 'deny' as const }) },
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, true);
});

test('坏插件只跳过自己，不影响别的插件与启动', async () => {
  const dir = await makeDir();
  await writeFile(path.join(dir, 'broken.mjs'), 'export const name = ;', 'utf8');
  await writeFile(
    path.join(dir, 'no-run.mjs'),
    "export const name = 'nope';\nexport const description = '没有 run';\n",
    'utf8',
  );
  await writeFile(
    path.join(dir, 'badname.mjs'),
    "export const name = 'Bad Name';\nexport const description = 'x';\nexport async function run() { return 'y'; }\n",
    'utf8',
  );
  await writeFile(
    path.join(dir, 'good.mjs'),
    "export const name = 'good';\nexport const description = 'ok';\nexport async function run() { return 'fine'; }\n",
    'utf8',
  );

  const { tools, errors } = await loadToolPlugins(dir);
  assert.deepEqual(tools.map((tool) => tool.name), ['good']);
  assert.equal(errors.length, 3);
  assert.ok(errors.some((error) => error.file === 'broken.mjs' && /加载失败/.test(error.reason)));
  assert.ok(errors.some((error) => error.file === 'no-run.mjs' && /缺 run/.test(error.reason)));
  assert.ok(errors.some((error) => error.file === 'badname.mjs' && /name 不合法/.test(error.reason)));
});

test('目录不存在时当作没有插件，不报错', async () => {
  const { tools, errors } = await loadToolPlugins(path.join(tmpdir(), 'rakko-no-such-dir-' + Date.now()));
  assert.deepEqual(tools, []);
  assert.deepEqual(errors, []);
});

test('插件 run 抛错会变成工具失败，而不是让运行崩掉', async () => {
  const dir = await makeDir();
  await writeFile(
    path.join(dir, 'boom.mjs'),
    "export const name = 'boom';\nexport const description = '会抛错';\nexport async function run() { throw new Error('插件自己炸了'); }\n",
    'utf8',
  );

  const { tools } = await loadToolPlugins(dir);
  const registry = new ToolRegistry({ workspace: dir });
  for (const tool of tools) registry.register(tool);

  const result = await registry.execute({ id: 'c1', name: 'boom', args: {} }, { approve: allow });
  assert.equal(result.ok, false);
  assert.match(result.output, /插件自己炸了/);
});
