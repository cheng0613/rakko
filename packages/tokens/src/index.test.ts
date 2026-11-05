import { test } from 'node:test';
import assert from 'node:assert/strict';

import { brand, css, dark, light, paletteVars, radius } from './index.js';

test('色板采样值就是品牌六色，不再有第二个十六进制来源', () => {
  assert.equal(light.accent, brand.waterBlue);
  assert.equal(light.text, '#33241B');
  assert.equal(dark.accent, '#7BCBF0');
});

test('浅深两套语义色必须一一对齐，缺一个就在深色模式漏一处', () => {
  assert.deepEqual(Object.keys(light).sort(), Object.keys(dark).sort());
});

test('paletteVars 把 camelCase 转成 CSS 自定义属性', () => {
  const vars = paletteVars(light);
  assert.match(vars, /--rk-accent: #5AA9EC;/);
  assert.match(vars, /--rk-text-secondary: #6E5C4E;/);
  assert.doesNotMatch(vars, /--rk-textSecondary/);
});

test('样式表同时带系统偏好与显式 data-theme 两条路径', () => {
  const sheet = css();
  assert.match(sheet, /prefers-color-scheme: dark/);
  assert.match(sheet, /\[data-theme="dark"\]/);
  assert.match(sheet, /:root:not\(\[data-theme="light"\]\)/);
  assert.match(sheet, /--rk-radius-pill: 999px/);
  assert.equal(radius.pill, 999);
});

test('不出现渐变与阴影 —— 这是设计硬约束，不是口味', () => {
  const sheet = css();
  assert.doesNotMatch(sheet, /gradient|box-shadow/);
});
