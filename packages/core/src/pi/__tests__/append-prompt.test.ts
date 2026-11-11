import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APPEND_PROMPT_FILENAME,
  AppendPromptError,
  INLINE_LIMIT,
  assertAppendPromptUsable,
  writeAppendPrompt,
} from "../append-prompt.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rakko-append-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("writeAppendPrompt —— 正常路径", () => {
  it("写入后返回绝对路径、字节数与 hash", async () => {
    const text = "你是 Rakko 的助手。";
    const result = await writeAppendPrompt(tmpRoot, [text]);

    expect(path.isAbsolute(result.absolutePath)).toBe(true);
    expect(result.absolutePath.endsWith(APPEND_PROMPT_FILENAME)).toBe(true);
    expect(result.bytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(result.hash).toMatch(/^[a-f0-9]{16}$/);

    const onDisk = await fs.readFile(result.absolutePath, "utf8");
    expect(onDisk).toBe(text);
  });

  it("多段按顺序拼接，空段跳过", async () => {
    const result = await writeAppendPrompt(tmpRoot, ["第一段", "   ", "", "第二段"]);
    const onDisk = await fs.readFile(result.absolutePath, "utf8");
    expect(onDisk).toBe("第一段\n\n第二段");
  });

  it("同一内容两次写入，hash 相同（可用于日志比对）", async () => {
    const a = await writeAppendPrompt(tmpRoot, ["固定内容"]);
    const b = await writeAppendPrompt(tmpRoot, ["固定内容"]);
    expect(a.hash).toBe(b.hash);
  });

  it("不留下临时文件", async () => {
    await writeAppendPrompt(tmpRoot, ["内容"]);
    const entries = await fs.readdir(tmpRoot);
    expect(entries).toEqual([APPEND_PROMPT_FILENAME]);
  });
});

describe("writeAppendPrompt —— 空内容必须拒绝", () => {
  it("全空段落抛 EMPTY", async () => {
    await expect(writeAppendPrompt(tmpRoot, ["", "   ", "\n"])).rejects.toMatchObject({
      code: "EMPTY",
    });
  });

  it("空数组抛 EMPTY", async () => {
    await expect(writeAppendPrompt(tmpRoot, [])).rejects.toBeInstanceOf(AppendPromptError);
  });
});

describe("assertAppendPromptUsable —— 防 pi 的静默降级（不变量 8）", () => {
  it("文件存在且非空时通过", async () => {
    const r = await writeAppendPrompt(tmpRoot, ["内容"]);
    await expect(assertAppendPromptUsable(r.absolutePath, r.bytes)).resolves.toBeUndefined();
  });

  it("文件不存在时必须抛错 —— 这是 pi 会静默当字面文本的情形", async () => {
    const missing = path.join(tmpRoot, "does-not-exist.md");
    await expect(assertAppendPromptUsable(missing)).rejects.toMatchObject({
      code: "STAT_FAILED",
    });
  });

  it("空文件必须抛错", async () => {
    const empty = path.join(tmpRoot, "empty.md");
    await fs.writeFile(empty, "", "utf8");
    await expect(assertAppendPromptUsable(empty)).rejects.toMatchObject({ code: "EMPTY" });
  });

  it("路径是目录时抛错", async () => {
    const dir = path.join(tmpRoot, "adir");
    await fs.mkdir(dir);
    await expect(assertAppendPromptUsable(dir)).rejects.toMatchObject({ code: "STAT_FAILED" });
  });

  it("相对路径必须抛错", async () => {
    await expect(assertAppendPromptUsable("relative/path.md")).rejects.toMatchObject({
      code: "NOT_ABSOLUTE",
    });
  });

  it("字节数与预期不符时抛错（文件被改动）", async () => {
    const r = await writeAppendPrompt(tmpRoot, ["内容"]);
    await expect(assertAppendPromptUsable(r.absolutePath, r.bytes + 100)).rejects.toMatchObject({
      code: "BYTE_MISMATCH",
    });
  });
});

describe("INLINE_LIMIT", () => {
  it("必须是保守值，远低于实测的 7,700 命令行上限", () => {
    expect(INLINE_LIMIT).toBeLessThanOrEqual(2000);
    expect(INLINE_LIMIT).toBeGreaterThan(0);
  });
});

describe("大内容必须能完整送达", () => {
  it("28KB 文本写入后字节数一致", async () => {
    const big = "X".repeat(28_000);
    const r = await writeAppendPrompt(tmpRoot, [big]);
    expect(r.bytes).toBe(28_000);
    const onDisk = await fs.readFile(r.absolutePath, "utf8");
    expect(onDisk.length).toBe(28_000);
  });

  it("中文按 UTF-8 字节数计算", async () => {
    const cn = "中文内容测试";
    const r = await writeAppendPrompt(tmpRoot, [cn]);
    expect(r.bytes).toBe(Buffer.byteLength(cn, "utf8"));
    expect(r.bytes).toBeGreaterThan(cn.length);
  });
});
