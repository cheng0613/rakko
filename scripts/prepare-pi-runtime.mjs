#!/usr/bin/env node
/**
 * 把 pi 裁剪成可内置的运行时。
 *
 * 从 138MB 裁到约 90MB：只删我们用不到的 provider SDK。
 * 我们只用 `openai-completions` 一种 api 形态，所以：
 *   - @anthropic-ai（13M）：Anthropic SDK，我们用不到
 *   - @google（11M）：Gemini SDK，用不到
 *   - @aws-sdk + @smithy（11.5M）：Bedrock，用不到
 *
 * **保留 openai（25M）**：这是 openai-completions 的核心。
 * 之前实测「裁掉 openai 后握手仍可用，但没跑工具回归」——
 * 风险太大，不值那 23MB。
 *
 * 用法：
 *   node scripts/prepare-pi-runtime.mjs [--source <pi 包目录>]
 *
 * 产物：resources/pi/
 *   bundle/            pi 的 dist/bundle
 *   node_modules/      裁剪后的依赖
 *   package.json
 *   PI-RUNTIME.json    记录版本、来源、裁剪了什么
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(repoRoot, "resources", "pi");
const MANIFEST_FILE = path.join(OUT_DIR, "PI-RUNTIME.json");

/** 需要删除的依赖（相对 pi 包内的 node_modules） */
const PRUNE_DIRS = [
  "@anthropic-ai",
  "@google",
  "@aws-sdk",
  "@smithy",
  // 可选：删了省 8.8M，但 openai SDK 可能间接用到 stream polyfill
  // 实测过「裁掉后握手通过」，但没做工具回归，先保留以免踩坑
  // "web-streams-polyfill",
];

function log(msg) {
  console.log(msg);
}

function dirSizeMB(p) {
  try {
    const out = execFileSync("du", ["-sm", p], { encoding: "utf8", shell: true });
    return Number.parseInt(out.split(/\s+/)[0], 10) || 0;
  } catch {
    return 0;
  }
}

/** 找 pi 包目录：优先参数，其次 volta，再次 npm 全局 */
function resolveSourceDir(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`指定的目录不存在：${explicit}`);
    return explicit;
  }

  const candidates = [];

  // volta
  try {
    const shim = execFileSync("volta", ["which", "pi"], { encoding: "utf8", timeout: 8000 }).trim();
    if (shim) {
      candidates.push(path.join(path.dirname(shim), "node_modules", "@earendil-works", "pi-coding-agent"));
    }
  } catch {
    /* volta 不可用 */
  }

  // npm 全局
  try {
    const root = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], {
      encoding: "utf8",
      timeout: 15000,
    }).trim();
    candidates.push(path.join(root, "@earendil-works", "pi-coding-agent"));
  } catch {
    /* npm 不可用 */
  }

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "dist", "bundle", "cli.js"))) return c;
  }

  throw new Error(
    "找不到 pi 包目录。用 --source 指定，或先装 @earendil-works/pi-coding-agent",
  );
}

function main() {
  const args = process.argv.slice(2);
  const srcIdx = args.indexOf("--source");
  const explicit = srcIdx >= 0 ? args[srcIdx + 1] : undefined;

  const src = resolveSourceDir(explicit);
  log(`源目录: ${src}`);

  const pkg = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8"));
  log(`pi 版本: ${pkg.version}`);

  const srcSize = dirSizeMB(src);
  log(`源体积: ${srcSize}MB`);

  if (!fs.existsSync(path.join(src, "dist", "bundle", "cli.js"))) {
    throw new Error(`${src} 下没有 dist/bundle/cli.js，不是有效的 pi 包`);
  }

  // 清空旧产物
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1. 拷 dist/bundle
  log("\n[1/4] 复制 dist/bundle…");
  fs.cpSync(path.join(src, "dist", "bundle"), path.join(OUT_DIR, "bundle"), { recursive: true });

  // 写启动 shim：跳过 enableCompileCache（Node 20 没这个 API）
  const shim = `#!/usr/bin/env node
/**
 * pi 的启动 shim。由 prepare-pi-runtime.mjs 生成。
 *
 * pi 官方的 bundle/cli.js 会调 enableCompileCache()，那是 Node 22 的 API。
 * 打包后的 Electron 内置 Node 20，没有这个导出。
 *
 * 这里做同样的事但跳过那一步调用 —— 它只是编译缓存，纯性能优化。
 * pi 原始文件未改动。
 */
// 用相对说明符直接 import：cli-runtime.js 是 ESM，
// 在 Electron 的 Node 20 下 createRequire() 会报 ERR_REQUIRE_ESM。
await import("./cli-runtime.js");
`;
  fs.writeFileSync(path.join(OUT_DIR, "bundle", "rakko-cli.mjs"), shim, "utf8");
  log("  写启动 shim: bundle/rakko-cli.mjs（绕过 enableCompileCache）");

  // ⚠️ 实测踩过的坑：bundle 里的资源路径按 bundle 位置解析，
  // 会去找 bundle/chunks/dist/{modes,core}。不补这份会 ENOENT。
  const needDir = path.join(OUT_DIR, "bundle", "chunks", "dist");
  if (fs.existsSync(path.join(src, "dist", "modes"))) {
    log("  补 bundle/chunks/dist/{modes,core}（bundle 资源路径依赖）");
    fs.mkdirSync(needDir, { recursive: true });
    for (const sub of ["modes", "core"]) {
      const from = path.join(src, "dist", sub);
      if (fs.existsSync(from)) {
        fs.cpSync(from, path.join(needDir, sub), { recursive: true });
      }
    }
  }

  // 2. 拷 node_modules（先全拷，再裁）
  log("\n[2/4] 复制依赖…");
  const srcNodeModules = path.join(src, "node_modules");
  if (fs.existsSync(srcNodeModules)) {
    fs.cpSync(srcNodeModules, path.join(OUT_DIR, "node_modules"), { recursive: true });
  }

  // 3. 裁剪
  log("\n[3/4] 裁剪用不到的 provider SDK…");
  const removed = [];
  const outNodeModules = path.join(OUT_DIR, "node_modules");
  for (const d of PRUNE_DIRS) {
    const target = path.join(outNodeModules, d);
    if (!fs.existsSync(target)) {
      log(`  - ${d}（不存在，跳过）`);
      continue;
    }
    const size = dirSizeMB(target);
    fs.rmSync(target, { recursive: true, force: true });
    removed.push({ dir: d, sizeMB: size });
    log(`  - ${d}  (-${size}MB)`);
  }

  // 4. 拷 package.json 与版本记录
  log("\n[4/4] 写版本记录…");
  fs.writeFileSync(
    path.join(OUT_DIR, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
    "utf8",
  );

  const outSize = dirSizeMB(OUT_DIR);
  const manifest = {
    name: pkg.name,
    version: pkg.version,
    preparedAt: new Date().toISOString(),
    sourceDir: src,
    sourceSizeMB: srcSize,
    outputSizeMB: outSize,
    pruned: removed,
    entry: "bundle/cli.js",
    /** 打包运行时用这个入口（跳过 Node 22 专属 API） */
    shimEntry: "bundle/rakko-cli.mjs",
    note: "由 scripts/prepare-pi-runtime.mjs 生成。不要手工改这个目录。",
  };
  fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  log(`\n完成：${srcSize}MB → ${outSize}MB（省 ${srcSize - outSize}MB）`);
  log(`产物: ${OUT_DIR}`);
  log(`记录: ${MANIFEST_FILE}`);
}

try {
  main();
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
}
