/**
 * 主进程侧的持久化服务。
 *
 * 把 RakkoDb 包起来，负责：
 *   - 打开数据库（进程级单例）
 *   - 项目/会话/消息的读写
 *   - 把运行时事件落库（用户消息、助手回复）
 */
import { app } from "electron";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RakkoDb, type MessageRow, type ProjectRow, type SessionRow } from "@rakko/core";
import type { ProjectInfo, SessionInfo } from "@rakko/shared";

export class PersistenceService {
  private db: RakkoDb | null = null;

  async open(): Promise<void> {
    if (this.db) return;
    const file = path.join(app.getPath("userData"), "rakko.db");
    this.db = await RakkoDb.open(file);
    console.log(`[db] 已打开 ${file}（schema v${this.db.schemaVersion}）`);
  }

  private getDb(): RakkoDb {
    if (!this.db) throw new Error("数据库还没打开");
    return this.db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  // ── 项目 ──

  /** 打开一个目录作为项目。已在库里就复用。 */
  openProject(cwd: string): ProjectInfo {
    const name = path.basename(cwd) || cwd;
    const row = this.getDb().upsertProject({ id: randomUUID(), name, cwd });
    return toProjectInfo(row);
  }

  listProjects(): ProjectInfo[] {
    return this.getDb().listProjects().map(toProjectInfo);
  }

  // ── 会话 ──

  /** 在项目下新建会话。标题先给个占位，收到第一条消息后按内容生成。 */
  createSession(projectId: string): SessionInfo {
    const row = this.getDb().createSession({
      id: randomUUID(),
      projectId,
      title: "新对话",
    });
    return toSessionInfo(row);
  }

  listSessions(projectId: string): SessionInfo[] {
    return this.getDb().listSessions(projectId).map(toSessionInfo);
  }

  /** 最近会话（首页「我的任务」用） */
  listRecentSessions(limit = 20): SessionInfo[] {
    return this.getDb().listAllSessions(limit).map(toSessionInfo);
  }

  getSession(id: string): SessionRow | null {
    return this.getDb().getSession(id);
  }

  renameSession(id: string, title: string): void {
    this.getDb().renameSession(id, title);
  }

  deleteSession(id: string): void {
    this.getDb().deleteSession(id);
  }

  // ── 消息 ──

  appendMessage(input: {
    sessionId: string;
    role: "user" | "assistant";
    content: string;
  }): MessageRow {
    return this.getDb().appendMessage(input);
  }

  listMessages(sessionId: string, options: { limit?: number; beforeId?: number } = {}): MessageRow[] {
    return this.getDb().listMessages(sessionId, options);
  }

  countMessages(sessionId: string): number {
    return this.getDb().countMessages(sessionId);
  }

  /**
   * 用首条用户消息生成会话标题。
   *
   * 只在标题还是占位时改，避免覆盖用户手动改的名字。
   */
  maybeAutoTitle(sessionId: string, firstUserMessage: string): void {
    const s = this.getDb().getSession(sessionId);
    if (!s) return;
    if (s.title !== "新对话") return;

    const cleaned = firstUserMessage.replace(/\s+/g, " ").trim();
    if (!cleaned) return;
    const title = cleaned.length > 30 ? `${cleaned.slice(0, 30)}…` : cleaned;
    this.getDb().renameSession(sessionId, title);
  }
}

function toProjectInfo(row: ProjectRow): ProjectInfo {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    lastOpenedAt: row.lastOpenedAt,
  };
}

function toSessionInfo(row: SessionRow): SessionInfo {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
