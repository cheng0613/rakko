#!/usr/bin/env node
/**
 * 把 @rakko/genui 打成浏览器能直接用的 IIFE，挂到 window.RakkoGenUI。
 *
 * 为什么不用 import：界面是自包含单文件（apps/web/index.html），没有打包器。
 * 但也正因如此，校验逻辑必须是同一份 —— 服务端拒绝的树，客户端不能照画。
 * 这里产出的就是同一份代码的浏览器版本。
 */

import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, 'apps', 'web', 'vendor');

await mkdir(outDir, { recursive: true });

const result = await build({
  entryPoints: [resolve(root, 'packages', 'genui', 'src', 'index.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'RakkoGenUI',
  platform: 'browser',
  target: ['es2020'],
  write: false,
  logLevel: 'warning',
});

const code = result.outputFiles?.[0]?.text;
if (!code) {
  console.error('打包 genui 失败：没有产物');
  process.exit(1);
}

const banner = '/* 由 scripts/build-genui-browser.mjs 生成，别手改；源在 packages/genui */\n';
await writeFile(resolve(outDir, 'genui.js'), banner + code, 'utf8');
console.log(`genui 浏览器版已生成：${(code.length / 1024).toFixed(1)} KB`);
