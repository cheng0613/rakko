/**
 * 本地数据库：项目、会话、消息。
 *
 * 用 better-sqlite3（同步 API，主进程友好）。
 * 它基于 N-API，同一份 prebuild 同时兼容 Node 与 Electron，
 * 不需要 electron-rebuild。
 *
 * 设计要点：
 *
 * 1. **迁移是增量的、可重复执行的。** 每次打开都跑一遍，靠 user_version 记录进度。
 *    绝不 DROP 表 —— 用户数据不能因为升级丢失。
 *
 * 2. **消息按会话分页查。** 长会话有几千条，不能一次全读进来。
 *
 * 3. **时间戳统一用毫秒整数。** SQLite 没有原生日期类型，字符串比较容易出错。
 */
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface ProjectRow {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
  lastOpenedAt: number;
}

export interface SessionRow {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 该会话的 pi 会话文件 id（用于 resume），还没跑过时为空 */
  sdkSessionId: string | null;
  /**
   * pi 的会话文件绝对路径。用于 --session 续接上下文。
   * 第一次跑完之后由会话运行时写回。
   */
  sessionFile: string | null;
}

export interface MessageRow {
  id: number;
  sessionId: string;
  role: "user" | "assistant";
  /** 纯文本内容。工具调用等结构化内容暂不落库 */
  content: string;
  createdAt: number;
}

/** 迁移脚本。**只追加，不修改已发布的条目。** */
const MIGRATIONS: ReadonlyArray<string> = [
  // v1：项目、会话、消息
  `
  CREATE TABLE IF NOT EXISTS projects (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    cwd           TEXT NOT NULL UNIQUE,
    created_at    INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    sdk_session_id  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_project
    ON sessions(project_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content     TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session
    ON messages(session_id, id);
  `,
  // v2：记录 pi 会话文件路径，用于上下文续接。
  // 已存在的库用 ALTER 补列（CREATE TABLE IF NOT EXISTS 不会改已有表）。
  `
  ALTER TABLE sessions ADD COLUMN session_file TEXT;
  `,
];

export class DbError extends Error {
  constructor(
    message: string,
    readonly code: "OPEN_FAILED" | "MIGRATION_FAILED",
  ) {
    super(message);
    this.name = "DbError";
  }
}

export class RakkoDb {
  private constructor(private readonly db: DB) {}

  /**
   * 打开（或创建）数据库并跑迁移。
   */
  static async open(filePath: string): Promise<RakkoDb> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    let raw: DB;
    try {
      raw = new Database(filePath);
      // WAL 让读写并发更好；主进程是多读取方
      raw.pragma("journal_mode = WAL");
      raw.pragma("foreign_keys = ON");
    } catch (e) {
      throw new DbError(`打开数据库失败：${(e as Error).message}`, "OPEN_FAILED");
    }

    const instance = new RakkoDb(raw);
    try {
      instance.migrate();
    } catch (e) {
      raw.close();
      throw new DbError(`迁移失败：${(e as Error).message}`, "MIGRATION_FAILED");
    }
    return instance;
  }

  /** 内存数据库，测试用 */
  static openInMemory(): RakkoDb {
    const raw = new Database(":memory:");
    raw.pragma("foreign_keys = ON");
    const instance = new RakkoDb(raw);
    instance.migrate();
    return instance;
  }

  private migrate(): void {
    const current = this.db.pragma("user_version", { simple: true }) as number;
    if (current >= MIGRATIONS.length) return;

    const run = this.db.transaction(() => {
      for (let v = current; v < MIGRATIONS.length; v++) {
        this.db.exec(MIGRATIONS[v]!);
      }
      this.db.pragma(`user_version = ${MIGRATIONS.length}`);
    });
    run();
  }

  /** 当前 schema 版本 */
  get schemaVersion(): number {
    return this.db.pragma("user_version", { simple: true }) as number;
  }

  // ── 项目 ──

  /** 登记一个项目。cwd 已存在时只更新 lastOpenedAt。 */
  upsertProject(input: { id: string; name: string; cwd: string }): ProjectRow {
    const now = Date.now();
    const existing = this.db
      .prepare("SELECT * FROM projects WHERE cwd = ?")
      .get(input.cwd) as RawProject | undefined;

    if (existing) {
      this.db.prepare("UPDATE projects SET last_opened_at = ? WHERE id = ?").run(now, existing.id);
      return toProject({ ...existing, last_opened_at: now });
    }

    this.db
      .prepare(
        "INSERT INTO projects (id, name, cwd, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(input.id, input.name, input.cwd, now, now);

    return {
      id: input.id,
      name: input.name,
      cwd: input.cwd,
      createdAt: now,
      lastOpenedAt: now,
    };
  }

  listProjects(): ProjectRow[] {
    const rows = this.db
      .prepare("SELECT * FROM projects ORDER BY last_opened_at DESC")
      .all() as RawProject[];
    return rows.map(toProject);
  }

  getProject(id: string): ProjectRow | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | RawProject
      | undefined;
    return row ? toProject(row) : null;
  }

  // ── 会话 ──

  createSession(input: { id: string; projectId: string; title: string }): SessionRow {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO sessions (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(input.id, input.projectId, input.title, now, now);

    return {
      id: input.id,
      projectId: input.projectId,
      title: input.title,
      createdAt: now,
      updatedAt: now,
      sdkSessionId: null,
      sessionFile: null,
    };
  }

  listSessions(projectId: string): SessionRow[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC")
      .all(projectId) as RawSession[];
    return rows.map(toSession);
  }

  /** 全部会话，最新的在前。首页的「我的任务」用这个 */
  listAllSessions(limit = 50): SessionRow[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as RawSession[];
    return rows.map(toSession);
  }

  getSession(id: string): SessionRow | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | RawSession
      | undefined;
    return row ? toSession(row) : null;
  }

  renameSession(id: string, title: string): void {
    this.db
      .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, Date.now(), id);
  }

  setSdkSessionId(id: string, sdkSessionId: string): void {
    this.db
      .prepare("UPDATE sessions SET sdk_session_id = ?, updated_at = ? WHERE id = ?")
      .run(sdkSessionId, Date.now(), id);
  }

  /** 记录 pi 会话文件路径，下次启动时用它续接上下文 */
  setSessionFile(id: string, sessionFile: string): void {
    this.db
      .prepare("UPDATE sessions SET session_file = ?, updated_at = ? WHERE id = ?")
      .run(sessionFile, Date.now(), id);
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  // ── 消息 ──

  appendMessage(input: {
    sessionId: string;
    role: "user" | "assistant";
    content: string;
  }): MessageRow {
    const now = Date.now();
    const info = this.db
      .prepare("INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(input.sessionId, input.role, input.content, now);

    // 顺带推进会话的 updated_at，首页排序靠它
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, input.sessionId);

    return {
      id: Number(info.lastInsertRowid),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      createdAt: now,
    };
  }

  /**
   * 分页读消息。
   *
   * `beforeId` 用于「往上翻」：只取比它更早的。
   * 不传则取最新的一页。
   */
  listMessages(sessionId: string, options: { limit?: number; beforeId?: number } = {}): MessageRow[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

    let rows: RawMessage[];
    if (options.beforeId !== undefined) {
      rows = this.db
        .prepare("SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?")
        .all(sessionId, options.beforeId, limit) as RawMessage[];
    } else {
      rows = this.db
        .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?")
        .all(sessionId, limit) as RawMessage[];
    }

    // 查询是倒序（取最近），返回时正过来
    return rows.reverse().map(toMessage);
  }

  countMessages(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as n FROM messages WHERE session_id = ?")
      .get(sessionId) as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}

interface RawProject {
  id: string;
  name: string;
  cwd: string;
  created_at: number;
  last_opened_at: number;
}

interface RawSession {
  id: string;
  project_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  sdk_session_id: string | null;
  session_file: string | null;
}

interface RawMessage {
  id: number;
  session_id: string;
  role: string;
  content: string;
  created_at: number;
}

function toProject(r: RawProject): ProjectRow {
  return {
    id: r.id,
    name: r.name,
    cwd: r.cwd,
    createdAt: r.created_at,
    lastOpenedAt: r.last_opened_at,
  };
}

function toSession(r: RawSession): SessionRow {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sdkSessionId: r.sdk_session_id,
    sessionFile: r.session_file ?? null,
  };
}

function toMessage(r: RawMessage): MessageRow {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role === "assistant" ? "assistant" : "user",
    content: r.content,
    createdAt: r.created_at,
  };
}
