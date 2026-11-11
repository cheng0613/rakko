#!/usr/bin/env node
/**
 * 打包后补拷贝 pi 运行时的 node_modules。
 *
 * 为什么不交给 electron-builder：
 * 它对 `extraResources` / `extraFiles` 的 from 目录会**自动排除 node_modules**
 * （假设那是应用自己的依赖，不该原样复制）。实测两种配置都拷不过去。
 *
 * 而 pi 加载 .ts 扩展依赖 jiti，缺一个模块就起不来
 * （报 `Failed to load extension: Cannot find module 'jiti'`）。
 *
 * 所以这里做一次显式复制。幂等：已存在就跳过。
 *
 * 用法：
 *   node scripts/copy-pi-runtime.mjs [--target <安装解包目录>]
 * 默认 target = release/win-unpacked
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(repoRoot, "resources", "pi");

const args = process.argv.slice(2);
const tIdx = args.indexOf("--target");
const TARGET_ROOT = tIdx >= 0 ? path.resolve(args[tIdx + 1]) : path.join(repoRoot, "release", "win-unpacked");
const DEST = path.join(TARGET_ROOT, "resources", "pi");

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n++;
  }
  return n;
}

function main() {
  if (!fs.existsSync(path.join(SRC, "bundle", "cli.js"))) {
    console.error(`✗ 源运行时不存在：${SRC}`);
    console.error("  先跑 pnpm pi:prepare");
    process.exit(1);
  }

  if (!fs.existsSync(TARGET_ROOT)) {
    console.error(`✗ 目标目录不存在：${TARGET_ROOT}`);
    console.error("  先跑 electron-builder");
    process.exit(1);
  }

  fs.mkdirSync(DEST, { recursive: true });

  // 1. 补 node_modules（electron-builder 会漏掉这个）
  const srcNm = path.join(SRC, "node_modules");
  const destNm = path.join(DEST, "node_modules");
  if (fs.existsSync(srcNm)) {
    fs.cpSync(srcNm, destNm, { recursive: true, force: true });
    console.log(`✓ 拷贝 node_modules（${countFiles(destNm)} 个文件）`);
  } else {
    console.log("! 源里没有 node_modules，跳过");
  }

  // 2. 确认关键文件都在
  const must = [
    ["bundle/cli.js", "pi 入口"],
    ["node_modules/jiti", "加载 .ts 扩展需要"],
    ["package.json", "版本信息"],
    ["PI-RUNTIME.json", "版本记录"],
  ];
  let bad = 0;
  for (const [rel, why] of must) {
    if (fs.existsSync(path.join(DEST, rel))) {
      console.log(`  ✓ ${rel}（${why}）`);
    } else {
      console.log(`  ✗ ${rel} 缺失（${why}）`);
      bad++;
    }
  }

  const total = countFiles(DEST);
  console.log(`\n产物文件总数：${total}`);

  if (bad > 0) {
    console.error(`\n✗ ${bad} 个必需文件缺失`);
    process.exit(1);
  }
  console.log(`✓ 内置运行时补齐完成：${DEST}`);
}

main();
