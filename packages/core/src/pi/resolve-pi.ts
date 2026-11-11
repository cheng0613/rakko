/**
 * 解析 pi 可执行入口。
 *
 * 开发期用系统已装的 pi（方案 C，见 AGENTS.md）。分发方式等 P1 再定。
 *
 * Windows 上 `volta which pi` 返回的是 shell 脚本，不能直接 spawn，
 * 必须解析到真正的 dist/bundle/cli.js。这里做三层探测：
 *
 *   1. 显式指定（环境变量 RAKKO_PI_ENTRY）
 *   2. node_modules 布局（npm/volta 全局安装都是这个形状）
 *   3. 直接给 js 入口（如果 PATH 上就是个 js）
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const BUNDLE_REL = "dist/bundle/cli.js";

export interface ResolvedPiEntry {
  /** 用 node 执行的 js 入口绝对路径 */
  entry: string;
  /** pi 包根目录 */
  packageDir: string;
  /** 版本号（从 package.json 读，读不到就 null） */
  version: string | null;
  /** 是怎么找到的，便于排查 */
  source: "env" | "volta" | "node-modules" | "direct";
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
  source: "env" | "system";
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
  const entry = path.join(candidateDir, BUNDLE_REL);
  if (!(await exists(entry))) return null;

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

  // 2. volta
  tried.push("volta which pi");
  const viaVolta = await resolveViaVolta();
  if (viaVolta) {
    cached = viaVolta;
    return cached;
  }

  // 3. npm 全局
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
  const looksLikeElectron = /electron/i.test(execPath) && !/node\.exe$/i.test(execPath);

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

  throw new PiNotFoundError(
    `找不到可用的 node（需要 >= ${MIN_NODE_MAJOR}）。` +
      `在 Electron 里不能用 process.execPath（它是 electron.exe），` +
      `请安装 node 或设置 RAKKO_NODE_BINARY。`,
    tried,
  );
}
