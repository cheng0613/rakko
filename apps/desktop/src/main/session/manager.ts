/**
 * 会话管理器：在主进程里持有会话运行时，转发事件到渲染进程。
 *
 * 事件流走 pub/sub（不变量：translator 不直接 webContents.send）。
 * 渲染进程按 sessionId 订阅，将来加手机推送 / IM 转发时不用改翻译层。
 */
import type { BrowserWindow } from "electron";
import { app } from "electron";
import path from "node:path";
import { IPC } from "@rakko/shared";
import type { AgentEvent, ProviderConfig } from "@rakko/shared";
import { SessionStartError, startSession, type SessionRuntime } from "@rakko/core";

export interface SessionManagerOptions {
  /** 取当前主窗口，用于推送事件 */
  getWindow: () => BrowserWindow | null;
}

interface ManagedSession {
  runtime: SessionRuntime;
  dataDir: string;
  subscribers: Set<string>;
}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();

  constructor(private readonly options: SessionManagerOptions) {}

  /**
   * 启动会话。同一 id 重复调用会先关掉旧的。
   */
  async start(input: {
    sessionId: string;
    cwd: string;
    providers: ProviderConfig[];
    /** 真实上游 key。只在主进程使用，不下发。 */
    apiKey: string;
    promptSections: string[];
    tools: string[] | "all";
  }): Promise<{ sessionId: string }> {
    await this.stop(input.sessionId);

    const dataDir = path.join(app.getPath("userData"), "sessions", input.sessionId);

    // P0 阶段 proxy 还没接。models.json 的 baseUrl 会指向一个未启动的端口，
    // 这是预期内的 —— 真接模型要等 CompatProxy（P0 剩余步骤）。
    const proxyPort = 0;

    const runtime = await startSession({
      sessionId: input.sessionId,
      dataDir,
      cwd: input.cwd,
      proxyPort,
      providers: input.providers,
      apiKey: input.apiKey,
      promptSections: input.promptSections,
      tools: input.tools,
      onEvent: (event) => this.broadcast(input.sessionId, event),
      log: (level, msg, meta) => {
        if (level === "error") console.error(`[session ${input.sessionId}] ${msg}`, meta ?? "");
        else console.log(`[session ${input.sessionId}] ${msg}`, meta ?? "");
      },
    });

    this.sessions.set(input.sessionId, {
      runtime,
      dataDir,
      subscribers: new Set(),
    });

    return { sessionId: input.sessionId };
  }

  async send(sessionId: string, text: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`会话不存在：${sessionId}`);
    await s.runtime.send(text);
  }

  async abort(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    await s.runtime.abort();
  }

  async stop(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    await s.runtime.dispose().catch((e: unknown) => {
      console.error(`[session ${sessionId}] dispose 失败`, e);
    });
  }

  async stopAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  /** 某个会话是否在运行 */
  isRunning(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.runtime.running ?? false;
  }

  /**
   * 广播事件给渲染进程。
   *
   * 形状固定为 { sessionId, event }，渲染端按 sessionId 过滤。
   */
  private broadcast(sessionId: string, event: AgentEvent): void {
    const win = this.options.getWindow();
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send(IPC.agentEvent, { sessionId, event });
    } catch (e) {
      console.error("推送事件失败", e);
    }
  }
}

export { SessionStartError };
