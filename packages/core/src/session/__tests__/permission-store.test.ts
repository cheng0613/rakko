import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PERMISSION_FILENAME,
  readPermissionMode,
  writePermissionMode,
} from "../permission-store.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "rakko-perm-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("权限档写入", () => {
  it("写进去什么就读出什么", async () => {
    for (const mode of ["ask", "auto", "bypassPermissions"] as const) {
      await writePermissionMode(dir, mode);
      expect(await readPermissionMode(dir)).toBe(mode);
    }
  });

  it("原子写：不留下临时文件", async () => {
    await writePermissionMode(dir, "auto");
    const entries = await fs.readdir(dir);
    expect(entries).toEqual([PERMISSION_FILENAME]);
  });

  it("文件内容是合法 JSON，且带 mode 与 updatedAt", async () => {
    await writePermissionMode(dir, "auto");
    const raw = await fs.readFile(path.join(dir, PERMISSION_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as { mode: string; updatedAt: number };
    expect(parsed.mode).toBe("auto");
    expect(typeof parsed.updatedAt).toBe("number");
  });
});

describe("不变量 4：fail-closed", () => {
  it("文件不存在时返回最严档 ask", async () => {
    expect(await readPermissionMode(dir)).toBe("ask");
  });

  it("文件是坏 JSON 时返回 ask", async () => {
    await fs.writeFile(path.join(dir, PERMISSION_FILENAME), "{not json", "utf8");
    expect(await readPermissionMode(dir)).toBe("ask");
  });

  it("mode 字段非法时返回 ask，不是 bypassPermissions", async () => {
    for (const bad of ['{"mode":"BYPASS"}', '{"mode":""}', '{"mode":null}', "{}", '{"mode":123}']) {
      await fs.writeFile(path.join(dir, PERMISSION_FILENAME), bad, "utf8");
      const mode = await readPermissionMode(dir);
      expect(mode).toBe("ask");
      expect(mode).not.toBe("bypassPermissions");
    }
  });

  it("写入非法档位时也落到 ask（不抛错、不放宽）", async () => {
    // @ts-expect-error 故意传非法值
    await writePermissionMode(dir, "bypass");
    expect(await readPermissionMode(dir)).toBe("ask");
  });
});

describe("目录不存在时", () => {
  it("写入会创建目录", async () => {
    const nested = path.join(dir, "a", "b", "c");
    await writePermissionMode(nested, "auto");
    expect(await readPermissionMode(nested)).toBe("auto");
  });

  it("读不存在的目录返回 ask", async () => {
    expect(await readPermissionMode(path.join(dir, "nope"))).toBe("ask");
  });
});
