#!/usr/bin/env node
/**
 * 把设计稿（design.html）里的 <style> 整段同步进界面，保证「界面 = 设计稿」。
 *
 * 用法：
 *   node scripts/sync-design.mjs <design.html 路径>
 *
 * 只替换 apps/web/index.html 里 ==DESIGN-CSS-START== / ==DESIGN-CSS-END== 之间的内容，
 * 生成物仍然是自包含单文件。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = process.argv[2];
if (!source) {
  console.error('用法：node scripts/sync-design.mjs <design.html 路径>');
  process.exit(1);
}

const designPath = resolve(source);
const html = await readFile(designPath, 'utf8');

const startTag = html.indexOf('<style>');
const endTag = html.indexOf('</style>');
if (startTag === -1 || endTag === -1) {
  console.error('设计稿里没有找到 <style> 块');
  process.exit(1);
}

const css = html.slice(startTag + '<style>'.length, endTag).trim();
const target = resolve(import.meta.dirname, '..', 'apps', 'web', 'index.html');
const page = await readFile(target, 'utf8');

const START = '/* ==DESIGN-CSS-START== */';
const END = '/* ==DESIGN-CSS-END== */';
const from = page.indexOf(START);
const to = page.indexOf(END);
if (from === -1 || to === -1) {
  console.error('界面文件里缺少 CSS 同步标记');
  process.exit(1);
}

const next = page.slice(0, from + START.length) + '\n' + css + '\n' + page.slice(to);
await writeFile(target, next, 'utf8');
console.log(`已同步 ${css.length} 字节 CSS：${designPath} → apps/web/index.html`);
