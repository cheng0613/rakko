import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PluginHost } from './plugin-host.js';
import { ToolRegistry } from './tools.js';

const plugin = (name: string, body = 'ok'): string =>
  [
    `export const name = '${name}';`,
    `export const description = '${name} 的说明';`,
    'export async function run() {',
    `  return '${body}';`,
    '}',
  ].join('\n');

const makeDir = async (): Promise<string> => mkdtemp(path.join(tmpdir(), 'rakko-host-'));

test('reload 会注册插件工具，再次 reload 先摘后挂', async () => {
  const dir = await makeDir();
  await writeFile(path.join(dir, 'a.mjs'), plugin('alpha', 'v1'), 'utf8');

  const registry = new ToolRegistry({ workspace: dir });
  registry.register({
    name: 'builtin_tool',
    description: '内置的，不该被插件重载影响',
    risk: 'low',
    requiresApproval: false,
    jsonSchema: { type: 'object' },
    run: async () => 'builtin',
  });

  const host = new PluginHost(registry, { directory: dir });
  const first = await host.reload();
  assert.deepEqual(first.tools.map((tool) => tool.name), ['alpha']);
  assert.equal(registry.get('alpha') !== undefined, true);

  // 改内容再重载：拿到的是新版本
  await writeFile(path.join(dir, 'a.mjs'), plugin('alpha', 'v2'), 'utf8');
  await host.reload();
  const result = await registry.execute({ id: 'c1', name: 'alpha', args: {} }, { approve: async () => ({ decision: 'allow' }) });
  assert.equal(result.output, 'v2');

  // 内置工具还在
  assert.equal(registry.get('builtin_tool') !== undefined, true);
});

test('插件文件被删掉后，工具从注册表里消失', async () => {
  const dir = await makeDir();
  await writeFile(path.join(dir, 'b.mjs'), plugin('beta'), 'utf8');

  const registry = new ToolRegistry({ workspace: dir });
  const host = new PluginHost(registry, { directory: dir });
  await host.reload();
  assert.equal(registry.get('beta') !== undefined, true);

  await rm(path.join(dir, 'b.mjs'));
  const after = await host.reload();
  assert.deepEqual(after.tools, []);
  assert.equal(registry.get('beta'), undefined);
});

test('坏插件不影响好的，错误会出现在 info 里', async () => {
  const dir = await makeDir();
  await writeFile(path.join(dir, 'good.mjs'), plugin('good'), 'utf8');
  await writeFile(path.join(dir, 'bad.mjs'), 'export const name = ;', 'utf8');

  const registry = new ToolRegistry({ workspace: dir });
  const host = new PluginHost(registry, { directory: dir });
  const info = await host.reload();

  assert.deepEqual(info.tools.map((tool) => tool.name), ['good']);
  assert.equal(info.errors.length, 1);
  assert.match(info.errors[0]?.file ?? '', /bad\.mjs/);
  assert.ok(info.reloadedAt);
});

test('watch 目录变动会触发重载（去抖后）', async () => {
  const dir = await makeDir();
  let reloads = 0;

  const registry = new ToolRegistry({ workspace: dir });
  const host = new PluginHost(registry, {
    directory: dir,
    debounceMs: 60,
    onReload: () => {
      reloads += 1;
    },
  });

  await host.reload();
  const base = reloads;

  host.watch();
  await writeFile(path.join(dir, 'c.mjs'), plugin('gamma'), 'utf8');

  for (let i = 0; i < 40 && registry.get('gamma') === undefined; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  host.close();
  assert.equal(registry.get('gamma') !== undefined, true, '新文件应该被自动挂上');
  assert.ok(reloads > base, '应该触发过回调');
});
