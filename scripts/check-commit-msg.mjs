#!/usr/bin/env node
// Rakko commit message 校验。规则见 docs/COMMITS.md
// 用法：node scripts/check-commit-msg.mjs <path-to-COMMIT_EDITMSG>
import { readFileSync } from "node:fs";

const TYPES = ["feat", "fix", "refactor", "chore", "docs", "test"];

const FEATURE_SCOPES = [
  "chat", "session", "project", "permission", "model", "proxy",
  "layout", "tool", "usage", "teammate", "plugin",
];
const LAYER_SCOPES = ["core", "shared", "desktop", "renderer", "ipc"];
const ALL_SCOPES = [...FEATURE_SCOPES, ...LAYER_SCOPES];

const MAX_DESC = 72;
const MIN_DESC = 4;

function fail(msg, hint) {
  console.error(`\n✗ ${msg}`);
  if (hint) console.error(hint);
  console.error(`\n  规则见 docs/COMMITS.md`);
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  fail("缺少参数：需要 COMMIT_EDITMSG 路径", "  用法：node scripts/check-commit-msg.mjs .git/COMMIT_EDITMSG");
}

let raw;
try {
  raw = readFileSync(file, "utf8");
} catch (e) {
  fail(`读不到 commit message 文件：${file}`, "  " + e.message);
}

const lines = raw.split("\n").filter((l) => !l.startsWith("#"));
const first = (lines.find((l) => l.trim().length > 0) || "").trim();

if (!first) fail("commit message 为空");

// merge / revert / fixup 等场景直接放行
if (/^(Merge |Revert |fixup! |squash! )/.test(first)) {
  console.log(`✓ 特殊提交，跳过校验：${first}`);
  process.exit(0);
}

const m = first.match(/^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/);
if (!m) {
  fail(
    `格式不对：${first}`,
    `  应为：<type>(<scope>): <中文描述>\n  例：feat(layout): 布局树支持递归 split`,
  );
}

const [, type, scope, bang, desc] = m;

if (!TYPES.includes(type)) {
  fail(`未知 type "${type}"`, `  允许：${TYPES.join(" / ")}`);
}

if (scope) {
  if (scope.includes(",")) {
    fail(`不要用多个 scope："${scope}"`, `  选主要功能域：${FEATURE_SCOPES.join(" ")}`);
  }
  if (!ALL_SCOPES.includes(scope)) {
    fail(
      `未知 scope "${scope}"`,
      `  功能域：${FEATURE_SCOPES.join(" ")}\n  技术层：${LAYER_SCOPES.join(" ")}`,
    );
  }
}

if (desc.length < MIN_DESC) fail(`描述太短（${desc.length} 字符）`);
if (desc.length > MAX_DESC) {
  fail(`描述过长（${desc.length} > ${MAX_DESC}）：${desc}`, `  建议压到 50 以内`);
}
if (/[。.]$/.test(desc)) fail(`描述不要以句号结尾：${desc}`);
if (!/[\u4e00-\u9fa5]/.test(desc)) fail(`描述请用中文：${desc}`);

if (bang && !/BREAKING[- ]CHANGE:/i.test(raw)) {
  fail(
    `用了 "!" 标注破坏性变更，但正文没有 BREAKING-CHANGE 说明`,
    `  加一行：BREAKING-CHANGE: <说明改了哪个对外契约>`,
  );
}

console.log(`✓ ${first}`);
