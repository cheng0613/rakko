import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DbError, RakkoDb } from "../database.js";

let db: RakkoDb;
let dir: string;

beforeEach(() => {
  db = RakkoDb.openInMemory();
});

afterEach(async () => {
  db.close();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe("迁移", () => {
  it("打开后 schema 版本是 1", () => {
    expect(db.schemaVersion).toBe(1);
  });

  it("重复打开不报错（幂等）", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "rakko-db-"));
    const file = path.join(dir, "rakko.db");

    const a = await RakkoDb.open(file);
    a.upsertProject({ id: "p1", name: "项目", cwd: "/tmp/x" });
    a.close();

    // 再开一次：迁移会重跑，但不能报错，数据要还在
    const b = await RakkoDb.open(file);
    expect(b.schemaVersion).toBe(1);
    expect(b.listProjects()).toHaveLength(1);
    b.close();
  });

  it("升级不丢数据（模拟再开一次）", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "rakko-db-"));
    const file = path.join(dir, "rakko.db");

    const a = await RakkoDb.open(file);
    const proj = a.upsertProject({ id: "p1", name: "项目", cwd: "/tmp/x" });
    const sess = a.createSession({ id: "s1", projectId: proj.id, title: "会话" });
    a.appendMessage({ sessionId: sess.id, role: "user", content: "你好" });
    a.close();

    const b = await RakkoDb.open(file);
    expect(b.listProjects()[0]?.name).toBe("项目");
    expect(b.listSessions("p1")[0]?.title).toBe("会话");
    expect(b.countMessages("s1")).toBe(1);
    b.close();
  });

  it("打开不存在的目录会创建", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "rakko-db-"));
    const file = path.join(dir, "a", "b", "rakko.db");
    const d = await RakkoDb.open(file);
    expect(d.schemaVersion).toBe(1);
    d.close();
  });
});

describe("项目", () => {
  it("新建后能列出", () => {
    db.upsertProject({ id: "p1", name: "Rakko", cwd: "/tmp/rakko" });
    const all = db.listProjects();
    expect(all).toHaveLength(1);
    expect(all[0]?.cwd).toBe("/tmp/rakko");
  });

  it("同 cwd 重复登记只更新 lastOpenedAt，不产生第二条", () => {
    const a = db.upsertProject({ id: "p1", name: "Rakko", cwd: "/tmp/rakko" });
    const b = db.upsertProject({ id: "p2", name: "改名了", cwd: "/tmp/rakko" });

    expect(db.listProjects()).toHaveLength(1);
    // 返回的是原有 id，不是新的
    expect(b.id).toBe(a.id);
    expect(b.lastOpenedAt).toBeGreaterThanOrEqual(a.lastOpenedAt);
  });

  it("按最近打开排序", async () => {
    db.upsertProject({ id: "p1", name: "老", cwd: "/tmp/a" });
    await new Promise((r) => setTimeout(r, 5));
    db.upsertProject({ id: "p2", name: "新", cwd: "/tmp/b" });

    expect(db.listProjects().map((p) => p.id)).toEqual(["p2", "p1"]);
  });

  it("getProject 查不到返回 null", () => {
    expect(db.getProject("nope")).toBeNull();
  });
});

describe("会话", () => {
  it("建会话后能列出", () => {
    db.upsertProject({ id: "p1", name: "P", cwd: "/tmp/a" });
    db.createSession({ id: "s1", projectId: "p1", title: "第一次对话" });

    const list = db.listSessions("p1");
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("第一次对话");
    expect(list[0]?.sdkSessionId).toBeNull();
  });

  it("listAllSessions 跨项目、按更新时间倒序", async () => {
    db.upsertProject({ id: "p1", name: "P1", cwd: "/tmp/a" });
    db.upsertProject({ id: "p2", name: "P2", cwd: "/tmp/b" });
    db.createSession({ id: "s1", projectId: "p1", title: "旧" });
    await new Promise((r) => setTimeout(r, 5));
    db.createSession({ id: "s2", projectId: "p2", title: "新" });

    expect(db.listAllSessions().map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("可以记录 sdkSessionId（用于 resume）", () => {
    db.upsertProject({ id: "p1", name: "P", cwd: "/tmp/a" });
    db.createSession({ id: "s1", projectId: "p1", title: "T" });
    db.setSdkSessionId("s1", "pi-session-abc");

    expect(db.getSession("s1")?.sdkSessionId).toBe("pi-session-abc");
  });

  it("改名会推进 updatedAt", async () => {
    db.upsertProject({ id: "p1", name: "P", cwd: "/tmp/a" });
    const s = db.createSession({ id: "s1", projectId: "p1", title: "旧标题" });
    await new Promise((r) => setTimeout(r, 5));
    db.renameSession("s1", "新标题");

    const after = db.getSession("s1")!;
    expect(after.title).toBe("新标题");
    expect(after.updatedAt).toBeGreaterThan(s.updatedAt);
  });

  it("删除会话会级联删除消息", () => {
    db.upsertProject({ id: "p1", name: "P", cwd: "/tmp/a" });
    db.createSession({ id: "s1", projectId: "p1", title: "T" });
    db.appendMessage({ sessionId: "s1", role: "user", content: "hi" });
    expect(db.countMessages("s1")).toBe(1);

    db.deleteSession("s1");
    expect(db.countMessages("s1")).toBe(0);
  });
});

describe("消息", () => {
  beforeEach(() => {
    db.upsertProject({ id: "p1", name: "P", cwd: "/tmp/a" });
    db.createSession({ id: "s1", projectId: "p1", title: "T" });
  });

  it("追加后按时间正序返回", () => {
    db.appendMessage({ sessionId: "s1", role: "user", content: "第一句" });
    db.appendMessage({ sessionId: "s1", role: "assistant", content: "第一答" });

    const list = db.listMessages("s1");
    expect(list.map((m) => m.content)).toEqual(["第一句", "第一答"]);
  });

  it("追加消息会推进会话的 updatedAt", async () => {
    const before = db.getSession("s1")!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    db.appendMessage({ sessionId: "s1", role: "user", content: "x" });
    expect(db.getSession("s1")!.updatedAt).toBeGreaterThan(before);
  });

  it("分页：默认取最近 50 条，按正序返回", () => {
    for (let i = 0; i < 70; i++) {
      db.appendMessage({ sessionId: "s1", role: "user", content: `m${i}` });
    }
    const page = db.listMessages("s1");
    expect(page).toHaveLength(50);
    expect(page[0]?.content).toBe("m20");
    expect(page[49]?.content).toBe("m69");
  });

  it("分页：beforeId 往上翻", () => {
    for (let i = 0; i < 10; i++) {
      db.appendMessage({ sessionId: "s1", role: "user", content: `m${i}` });
    }
    const first = db.listMessages("s1", { limit: 4 });
    expect(first.map((m) => m.content)).toEqual(["m6", "m7", "m8", "m9"]);

    const older = db.listMessages("s1", { limit: 4, beforeId: first[0]!.id });
    expect(older.map((m) => m.content)).toEqual(["m2", "m3", "m4", "m5"]);
  });

  it("limit 被夹在 1..200", () => {
    for (let i = 0; i < 5; i++) {
      db.appendMessage({ sessionId: "s1", role: "user", content: `m${i}` });
    }
    expect(db.listMessages("s1", { limit: 0 })).toHaveLength(1);
    expect(db.listMessages("s1", { limit: 9999 })).toHaveLength(5);
  });

  it("role 只接受 user / assistant", () => {
    expect(() =>
      db.appendMessage({
        sessionId: "s1",
        // @ts-expect-error 故意传非法值
        role: "system",
        content: "x",
      }),
    ).toThrow();
  });

  it("不同会话的消息不互相污染", () => {
    db.createSession({ id: "s2", projectId: "p1", title: "另一个" });
    db.appendMessage({ sessionId: "s1", role: "user", content: "给 s1" });
    db.appendMessage({ sessionId: "s2", role: "user", content: "给 s2" });

    expect(db.listMessages("s1").map((m) => m.content)).toEqual(["给 s1"]);
    expect(db.listMessages("s2").map((m) => m.content)).toEqual(["给 s2"]);
  });
});

describe("外键约束", () => {
  it("给不存在的会话插消息会失败", () => {
    expect(() =>
      db.appendMessage({ sessionId: "no-such", role: "user", content: "x" }),
    ).toThrow();
  });

  it("给不存在的项目建会话会失败", () => {
    expect(() => db.createSession({ id: "s1", projectId: "no-such", title: "T" })).toThrow();
  });
});

describe("错误类型", () => {
  it("DbError 带 code", () => {
    const e = new DbError("x", "OPEN_FAILED");
    expect(e.code).toBe("OPEN_FAILED");
    expect(e).toBeInstanceOf(Error);
  });
});
