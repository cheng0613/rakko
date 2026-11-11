#!/usr/bin/env node
/**
 * 在 Node ABI 与 Electron ABI 之间切换 better-sqlite3 的编译产物。
 *
 * 背景：better-sqlite3 是原生模块，必须针对运行时 ABI 编译。
 * Electron 33 是 ABI 130（Node 20），系统 Node 22 是 ABI 127。
 * 两者不能共用一个 .node 文件，而 npm 只认 build/Release/better_sqlite3.node 这一个路径。
 *
 * 做法：保留两份编译产物，按需要切换。
 *   build/Release/better_sqlite3.node          ← 当前生效的
 *   build/Release/better_sqlite3.node.node       ← Node ABI 备份
 *   build/Release/better_sqlite3.node.electron   ← Electron ABI 备份
 *
 * 用法：
 *   node scripts/switch-native.mjs node       切到 Node（跑测试用）
 *   node scripts/switch-native.mjs electron   切到 Electron（跑应用用）
 *   node scripts/switch-native.mjs status     查看当前状态
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MODULE_DIR = path.join(
  repoRoot,
  "node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3",
);
const RELEASE_DIR = path.join(MODULE_DIR, "build/Release");
const ACTIVE = path.join(RELEASE_DIR, "better_sqlite3.node");
const NODE_BACKUP = path.join(RELEASE_DIR, "better_sqlite3.node.nodeabi");
const ELECTRON_BACKUP = path.join(RELEASE_DIR, "better_sqlite3.node.electronabi");

const ELECTRON_VERSION = "35.7.5";

function exists(p) {
  return fs.existsSync(p);
}

function status() {
  const lines = [];
  lines.push(`模块目录: ${MODULE_DIR}`);
  lines.push(`生效: ${exists(ACTIVE) ? `${(fs.statSync(ACTIVE).size / 1024).toFixed(0)}KB` : "缺失"}`);
  lines.push(`Node ABI 备份: ${exists(NODE_BACKUP) ? "有" : "无"}`);
  lines.push(`Electron ABI 备份: ${exists(ELECTRON_BACKUP) ? "有" : "无"}`);
  console.log(lines.join("\n"));
}

/**
 * 判断当前 .node 是哪个 ABI 编译的。
 *
 * 不能靠 require 试 —— 在同进程里 require 成功后会被缓存，
 * 且 electron-rebuild 的产物可能仍能 require 到旧句柄。
 * 直接比对文件字节与备份。
 */
function currentAbi() {
  if (!exists(ACTIVE)) return "missing";
  const active = fs.readFileSync(ACTIVE);
  if (exists(NODE_BACKUP) && Buffer.compare(active, fs.readFileSync(NODE_BACKUP)) === 0) {
    return "node";
  }
  if (exists(ELECTRON_BACKUP) && Buffer.compare(active, fs.readFileSync(ELECTRON_BACKUP)) === 0) {
    return "electron";
  }
  return "unknown";
}

function switchTo(target) {
  if (!exists(MODULE_DIR)) {
    console.error(`找不到 better-sqlite3：${MODULE_DIR}`);
    console.error("先跑 pnpm install");
    process.exit(1);
  }

  const current = currentAbi();

  if (target === "node") {
    if (current === "node") {
      console.log("已经是 Node ABI，无需切换");
      return;
    }
    if (current === "unknown" && exists(NODE_BACKUP)) {
      // 未知状态：优先用备份覆盖，比保留未知产物安全
      fs.copyFileSync(NODE_BACKUP, ACTIVE);
      console.log("✓ 当前产物未知，已用 Node ABI 备份覆盖");
      return;
    }
    // 当前是 electron ABI：先备份它
    if (exists(ACTIVE)) fs.copyFileSync(ACTIVE, ELECTRON_BACKUP);
    if (!exists(NODE_BACKUP)) {
      console.log("没有 Node ABI 备份，正在用 npm rebuild 编译…");
      execFileSync("npm", ["rebuild", "better-sqlite3"], {
        cwd: repoRoot,
        stdio: "inherit",
        shell: true,
      });
      if (exists(ACTIVE)) fs.copyFileSync(ACTIVE, NODE_BACKUP);
      console.log("✓ 已编译并备份 Node ABI");
      return;
    }
    fs.copyFileSync(NODE_BACKUP, ACTIVE);
    console.log("✓ 已切到 Node ABI");
    return;
  }

  if (target === "electron") {
    if (current === "electron") {
      console.log("已经是 Electron ABI，无需切换");
      return;
    }
    if (exists(ACTIVE)) fs.copyFileSync(ACTIVE, NODE_BACKUP);
    if (exists(ELECTRON_BACKUP)) {
      fs.copyFileSync(ELECTRON_BACKUP, ACTIVE);
      console.log("✓ 已切到 Electron ABI（用备份）");
      return;
    }
    console.log("没有 Electron ABI 备份，正在重建…");
    execFileSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["@electron/rebuild", "-f", "-w", "better-sqlite3", "-v", ELECTRON_VERSION, "--arch", "x64"],
      { cwd: repoRoot, stdio: "inherit", shell: true },
    );
    if (exists(ACTIVE)) fs.copyFileSync(ACTIVE, ELECTRON_BACKUP);
    console.log("✓ 已重建并备份 Electron ABI");
    return;
  }

  console.error(`未知目标：${target}（只认 node / electron / status）`);
  process.exit(1);
}

const cmd = process.argv[2] ?? "status";
if (cmd === "status") {
  status();
  console.log("");
  console.log(`当前生效: ${currentAbi()}`);
} else {
  switchTo(cmd);
}
