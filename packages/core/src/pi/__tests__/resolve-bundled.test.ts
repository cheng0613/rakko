import { promises as fs } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resolvePiEntry, resetPiEntryCache } from "../resolve-pi.js";

/**
 * 内置运行时的解析测试。
 *
 * 前提：仓库里跑过 `node scripts/prepare-pi-runtime.mjs`。
 * 没跑过时这些测试会跳过（CI 里不要求先生成 94MB 产物）。
 */
const BUNDLED_DIR = path.resolve(process.cwd(), "../../resources/pi");
const hasBundled = await fs
  .access(path.join(BUNDLED_DIR, "bundle", "cli.js"))
  .then(() => true)
  .catch(() => false);

describe.skipIf(!hasBundled)("内置 pi 运行时", () => {
  beforeEach(() => {
    resetPiEntryCache();
  });

  it("解析到内置运行时（不是系统 pi）", async () => {
    const entry = await resolvePiEntry({ forceRefresh: true });
    expect(entry.source).toBe("bundled");
    // Node 22+ 直接用 cli.js；Node < 22 才用 shim。
    const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
    const expected = nodeMajor >= 22 ? "cli.js" : "rakko-cli.mjs";
    expect(entry.entry).toContain(path.join("resources", "pi", "bundle", expected));
  });

  it("版本与 PI-RUNTIME.json 记录一致", async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(BUNDLED_DIR, "PI-RUNTIME.json"), "utf8"),
    ) as { version: string };
    const entry = await resolvePiEntry({ forceRefresh: true });
    expect(entry.version).toBe(manifest.version);
  });

  it("bundle/chunks/dist 资源目录存在（否则 pi 启动会 ENOENT）", async () => {
    const modes = path.join(BUNDLED_DIR, "bundle", "chunks", "dist", "modes");
    await expect(fs.access(modes)).resolves.toBeUndefined();
  });
});

describe.skipIf(hasBundled)("内置运行时缺失时的回落", () => {
  it("没有内置产物时回落到系统 pi", async () => {
    resetPiEntryCache();
    const entry = await resolvePiEntry({ forceRefresh: true });
    // 系统上有 pi（volta 或 npm 全局）
    expect(["volta", "node-modules", "env", "direct"]).toContain(entry.source);
  });
});
