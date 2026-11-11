/**
 * 解析 pi 可执行入口。
 *
 * 探测顺序（先能用内置，再回落系统）：
 *   1. 显式指定（RAKKO_PI_ENTRY）
 *   2. **随包内置**（resources/pi/，由 prepare-pi-runtime.mjs 生成）
 *   3. volta / npm 全局（开发期）
 *
 * Windows 上 `volta which pi` 返回的是 shell 脚本，不能直接 spawn，
 * 必须解析到真正的 dist/bundle/cli.js。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * cli.js 相对包根的两个可能位置：
 *   - npm 包布局：dist/bundle/cli.js
 *   - 内置裁剪版：bundle/cli.js（prepare-pi-runtime.mjs 的产物）
 */
const BUNDLE_RELS = ["dist/bundle/cli.js", "bundle/cli.js"];

/**
 * 内置运行时优先用这个入口。
 *
 * 它跳过 pi 的 enableCompileCache()（Node 22 才有的 API），
 * 这样打包后的 Electron（Node 20）也能跑，不需要额外内置 87MB 的 node。
 */
const BUNDLED_SHIM_REL = "bundle/rakko-cli.mjs";

export interface ResolvedPiEntry {
  /** 用 node 执行的 js 入口绝对路径 */
  entry: string;
  /** pi 包根目录 */
  packageDir: string;
  /** 版本号（从 package.json 读，读不到就 null） */
  version: string | null;
  /** 是怎么找到的，便于排查 */
  source: "env" | "bundled" | "volta" | "node-modules" | "direct";
}

/**
 * 能跑 pi 的 node 可执行文件。
 *
 * ⚠️ 不能在 Electron 里用 process.execPath —— 那里它是 electron.exe，
 * 直接跑 js 会报「App threw an error during load」。
 * ELECTRON_RUN_AS_NODE=1 也不可靠：Electron 33 的 Node 版本较旧，
 * 跑 pi 1.4.0 会在 enableCompileCache 上 SyntaxError。
 *
 * 必须解析出真正的 node 二进制（不是 shim）。
 */
export interface ResolvedNodeBinary {
  path: string;
  version: string;
  source: "env" | "system" | "electron-run-as-node";
  /**
   * spawn 时需要附加的环境变量。
   *
   * 打包版没有独立 node 时，用 Electron 自带的 Node：
   * path = Rakko.exe，extraEnv = { ELECTRON_RUN_AS_NODE: "1" }。
   */
  extraEnv?: Record<string, string>;
}

const MIN_NODE_MAJOR = 22;

export class PiNotFoundError extends Error {
  constructor(message: string, readonly tried: string[]) {
    super(message);
    this.name = "PiNotFoundError";
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 从 packageDir 读出 pi 版本 */
async function readVersion(packageDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(packageDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * 验证一个候选目录确实是 pi 包：有 dist/bundle/cli.js 且 package.json 里是 pi。
 */
async function toEntry(
  candidateDir: string,
  source: ResolvedPiEntry["source"],
): Promise<ResolvedPiEntry | null> {
  let entry: string | null = null;

  // 内置产物直接用 cli.js。
  //
  // 曾经用过一个跳过 enableCompileCache 的 shim，为了兼容 Electron 33 的 Node 20。
  // 升级到 Electron 35（Node 22）后不再需要 —— 而且 shim 的顶层 await
  // 在某些路径下不可靠。保留 shim 文件只是为了兼容旧产物。
  if (source === "bundled") {
    const shim = path.join(candidateDir, BUNDLED_SHIM_REL);
    const plain = path.join(candidateDir, "bundle/cli.js");
    // 只有 Node < 22 时才需要 shim
    const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
    if (nodeMajor < 22 && (await exists(shim))) {
      entry = shim;
    } else if (await exists(plain)) {
      entry = plain;
    }
  }

  if (!entry) {
    for (const rel of BUNDLE_RELS) {
      const candidate = path.join(candidateDir, rel);
      if (await exists(candidate)) {
        entry = candidate;
        break;
      }
    }
  }
  if (!entry) return null;

  try {
    const raw = await fs.readFile(path.join(candidateDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { name?: string };
    if (pkg.name !== "@earendil-works/pi-coding-agent") return null;
  } catch {
    return null;
  }

  return {
    entry,
    packageDir: candidateDir,
    version: await readVersion(candidateDir),
    source,
  };
}

/**
 * 找随包内置的 pi 运行时。
 *
 * 目录形如 <app>/resources/pi/，里面是 prepare-pi-runtime.mjs 的产物：
 *   bundle/cli.js + node_modules/ + package.json
 *
 * 三个锚点（都不依赖 import.meta.url，避免被打包器/测试转换后失效）：
 *   1. RAKKO_PI_RUNTIME_DIR 环境变量
 *   2. process.resourcesPath/pi —— 打包后 Electron 的 resources 目录
 *   3. 从 process.cwd() 向上找 resources/pi —— 开发期（cwd 是 workspace 根或子包）
 */
async function resolveBundled(): Promise<ResolvedPiEntry | null> {
  const candidates: string[] = [];

  const fromEnv = process.env["RAKKO_PI_RUNTIME_DIR"];
  if (fromEnv) candidates.push(fromEnv);

  // 打包后
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (typeof resourcesPath === "string" && resourcesPath.length > 0) {
    candidates.push(path.join(resourcesPath, "pi"));
  }

  // 开发期：从 cwd 与模块目录同时向上找
  const anchors = [process.cwd(), path.dirname(fileURLToPath(import.meta.url))];
  for (const anchor of anchors) {
    let dir = anchor;
    for (let i = 0; i < 6; i++) {
      candidates.push(path.join(dir, "resources", "pi"));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  for (const c of candidates) {
    const hit = await toEntry(c, "bundled");
    if (hit) return hit;
  }
  return null;
}

/** 从 `volta which pi` 的输出推导包根目录 */
async function resolveViaVolta(): Promise<ResolvedPiEntry | null> {
  try {
    const { stdout } = await execFileAsync("volta", ["which", "pi"], {
      timeout: 8000,
      windowsHide: true,
    });
    const shim = stdout.trim();
    if (!shim) return null;

    // shim 形如:
    //   ...\toolimage\packages\@earendil-works\pi-coding-agent\pi
    // 包根在 node_modules/@earendil-works/pi-coding-agent
    const dir = path.dirname(shim);
    const candidates = [
      path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent"),
      dir,
    ];
    for (const c of candidates) {
      const hit = await toEntry(c, "volta");
      if (hit) return hit;
    }
  } catch {
    /* volta 不可用，继续后面的探测 */
  }
  return null;
}

/** npm/pnpm 全局安装：从 PATH 上的 node_modules 找 */
async function resolveViaNodeModules(): Promise<ResolvedPiEntry | null> {
  const roots: string[] = [];
  try {
    const { stdout } = await execFileAsync(process.platform === "win32" ? "npm.cmd" : "npm", [
      "root",
      "-g",
    ], { timeout: 15000, windowsHide: true });
    roots.push(stdout.trim());
  } catch {
    /* npm 不可用 */
  }

  for (const root of roots) {
    if (!root) continue;
    const hit = await toEntry(
      path.join(root, "@earendil-works", "pi-coding-agent"),
      "node-modules",
    );
    if (hit) return hit;
  }
  return null;
}

let cached: ResolvedPiEntry | null = null;

/**
 * 解析 pi 入口。结果会缓存 —— 同一进程内不必反复探测。
 */
export async function resolvePiEntry(options: { forceRefresh?: boolean } = {}): Promise<ResolvedPiEntry> {
  if (cached && !options.forceRefresh) return cached;

  const tried: string[] = [];

  // 1. 显式指定
  const fromEnv = process.env["RAKKO_PI_ENTRY"];
  if (fromEnv) {
    tried.push(`env RAKKO_PI_ENTRY=${fromEnv}`);
    // 允许直接给 cli.js，也允许给包根
    if (fromEnv.endsWith(".js")) {
      if (await exists(fromEnv)) {
        const packageDir = path.resolve(path.dirname(fromEnv), "../../..");
        cached = { entry: fromEnv, packageDir, version: await readVersion(packageDir), source: "env" };
        return cached;
      }
    } else {
      const hit = await toEntry(fromEnv, "env");
      if (hit) {
        cached = hit;
        return cached;
      }
    }
  }

  // 2. 内置运行时（发布版优先用这个）
  tried.push("resources/pi（内置）");
  const bundled = await resolveBundled();
  if (bundled) {
    cached = bundled;
    return cached;
  }

  // 3. volta（开发期）
  tried.push("volta which pi");
  const viaVolta = await resolveViaVolta();
  if (viaVolta) {
    cached = viaVolta;
    return cached;
  }

  // 4. npm 全局
  tried.push("npm root -g");
  const viaNpm = await resolveViaNodeModules();
  if (viaNpm) {
    cached = viaNpm;
    return cached;
  }

  throw new PiNotFoundError(
    "找不到 pi。请先安装 @earendil-works/pi-coding-agent，或设置 RAKKO_PI_ENTRY 指向 dist/bundle/cli.js。",
    tried,
  );
}

/** 测试用：清掉缓存 */
export function resetPiEntryCache(): void {
  cached = null;
  cachedNode = null;
}

/**
 * 解析一个可用的 node 二进制。
 *
 * 优先级：
 *   1. RAKKO_NODE_BINARY
 *   2. PATH 上的 node（跳过 shim，要求能跑 --version 且主版本 >= 22）
 *
 * 在 Electron 里调用时，PATH 上的 node 会指向真的 node 而不是 electron。
 */
async function probeNodeBinary(candidate: string): Promise<ResolvedNodeBinary | null> {
  try {
    const { stdout } = await execFileAsync(candidate, ["--version"], {
      timeout: 8000,
      windowsHide: true,
    });
    const raw = stdout.trim().replace(/^v/, "");
    const major = Number.parseInt(raw.split(".")[0] ?? "0", 10);
    if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) return null;
    return { path: candidate, version: raw, source: "system" };
  } catch {
    return null;
  }
}

let cachedNode: ResolvedNodeBinary | null = null;

export async function resolveNodeBinary(options: { forceRefresh?: boolean } = {}): Promise<ResolvedNodeBinary> {
  if (cachedNode && !options.forceRefresh) return cachedNode;

  const tried: string[] = [];

  const fromEnv = process.env["RAKKO_NODE_BINARY"];
  if (fromEnv) {
    tried.push(`env RAKKO_NODE_BINARY=${fromEnv}`);
    const hit = await probeNodeBinary(fromEnv);
    if (hit) {
      cachedNode = { ...hit, source: "env" };
      return cachedNode;
    }
  }

  // 注意：在 Electron 主进程里，process.execPath 是 electron.exe，不能用。
  // 这里显式排除，避免悄悄拿错。
  const execPath = process.execPath;
  const looksLikeElectron = /electron/i.test(execPath) || /rakko/i.test(execPath);

  const candidates: string[] = [];
  if (!looksLikeElectron) candidates.push(execPath);
  if (process.platform === "win32") {
    candidates.push("node.exe", "node");
  } else {
    candidates.push("node");
  }

  for (const c of candidates) {
    tried.push(c);
    const hit = await probeNodeBinary(c);
    if (hit) {
      cachedNode = hit;
      return cachedNode;
    }
  }

  // 4. 最后兜底：用 Electron 自带的 Node（ELECTRON_RUN_AS_NODE=1）
  //    打包版没有独立 node 时靠这个。
  //    注意 Electron 33 内置 Node 20，所以内置 pi 的启动 shim 必须跳过
  //    enableCompileCache（Node 22 才有）——见 prepare-pi-runtime.mjs。
  if (looksLikeElectron) {
    tried.push(`${execPath} + ELECTRON_RUN_AS_NODE=1`);
    const probe = await probeNodeWithElectron(execPath);
    if (probe) {
      cachedNode = probe;
      return cachedNode;
    }
  }

  throw new PiNotFoundError(
    `找不到可用的 node（需要 >= ${MIN_NODE_MAJOR}）。` +
      `在 Electron 里不能用 process.execPath 直接跑 js，` +
      `请安装 node 或设置 RAKKO_NODE_BINARY。`,
    tried,
  );
}

/**
 * 用 Electron 自带的 Node 跑一次 --version。
 *
 * 这是打包版的主要路径：安装包里没有独立 node，
 * 但 Electron 进程本身带 Node 运行时，加这个环境变量就变成 node。
 *
 * 版本可能低于 MIN_NODE_MAJOR（Electron 33 是 Node 20）——
 * 这一条是**兜底**，所以不按 MIN_NODE_MAJOR 拒绝，但会记录下来。
 */
async function probeNodeWithElectron(
  execPath: string,
): Promise<ResolvedNodeBinary | null> {
  try {
    const { stdout } = await execFileAsync(execPath, ["--version"], {
      timeout: 10000,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    const raw = stdout.trim().replace(/^v/, "");
    if (!raw) return null;
    return {
      path: execPath,
      version: raw,
      source: "electron-run-as-node",
      extraEnv: { ELECTRON_RUN_AS_NODE: "1" },
    };
  } catch {
    return null;
  }
}
