/**
 * 会话管理器：持有会话运行时 + CompatProxy，转发事件到渲染进程。
 *
 * proxy 是进程级的（一个实例服务所有会话），按 sessionId 区分上游与 key。
 */
import type { BrowserWindow } from "electron";
import { app } from "electron";
import path from "node:path";
import { IPC } from "@rakko/shared";
import type { AgentEvent, ProviderConfig, TokenUsage } from "@rakko/shared";
import { SessionStartError, startSession, type SessionRuntime } from "@rakko/core";
import { createCompatProxy, type ProxyHandle } from "@rakko/proxy";

export interface SessionManagerOptions {
  getWindow: () => BrowserWindow | null;
  /** 持久化服务。没有时不落库（开发/测试） */
  persistence?: {
    appendMessage(input: {
      sessionId: string;
      role: "user" | "assistant";
      content: string;
    }): unknown;
    maybeAutoTitle(sessionId: string, firstUserMessage: string): void;
    /** 取上次记录的 pi 会话文件路径，用于续接上下文 */
    getSessionFile(sessionId: string): string | null;
    /** 记录 pi 会话文件路径 */
    setSessionFile(sessionId: string, path: string): void;
  };
}

interface ManagedSession {
  runtime: SessionRuntime;
  dataDir: string;
}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private proxy: ProxyHandle | null = null;
  private proxyStarting: Promise<ProxyHandle> | null = null;
  private readonly usage = new Map<string, TokenUsage>();

  constructor(private readonly options: SessionManagerOptions) {}

  /**
   * 懒启动 proxy。全进程共用一个。
   */
  private async ensureProxy(): Promise<ProxyHandle> {
    if (this.proxy) return this.proxy;
    if (this.proxyStarting) return this.proxyStarting;

    this.proxyStarting = (async () => {
      const handle = await createCompatProxy({
        // 会话标识走自定义头，由 pi 的 provider 配置注入。
        // 没有时回落到单会话模式（P0 只有一个会话）。
        resolveSession: (req) => {
          const raw = req.headers["x-rakko-session-id"];
          if (typeof raw === "string" && raw.length > 0) return raw;
          // 回落：当前唯一活跃会话
          const ids = [...this.sessions.keys()];
          return ids.length === 1 ? ids[0]! : null;
        },
        observers: {
          onUsage: (sessionId, delta) => {
            const prev = this.usage.get(sessionId) ?? {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            };
            this.usage.set(sessionId, {
              inputTokens: prev.inputTokens + delta.inputTokens,
              outputTokens: prev.outputTokens + delta.outputTokens,
              cacheReadTokens: prev.cacheReadTokens + delta.cacheReadTokens,
              cacheWriteTokens: prev.cacheWriteTokens + delta.cacheWriteTokens,
            });
          },
          onUpstreamError: (sessionId, status, detail) => {
            console.error(`[proxy ${sessionId}] 上游错误 ${status}: ${detail.slice(0, 300)}`);
          },
          log: (level, msg, meta) => {
            if (level === "error") console.error(`[proxy] ${msg}`, meta ?? "");
            else console.log(`[proxy] ${msg}`, meta ?? "");
          },
        },
      });
      this.proxy = handle;
      console.log(`[proxy] 已启动 ${handle.url}`);
      return handle;
    })();

    try {
      return await this.proxyStarting;
    } finally {
      this.proxyStarting = null;
    }
  }

  async start(input: {
    sessionId: string;
    cwd: string;
    providers: ProviderConfig[];
    apiKey: string;
    promptSections: string[];
    tools: string[] | "all";
    initialPermissionMode?: import("@rakko/shared").PermissionMode;
  }): Promise<{ sessionId: string; proxyUrl: string }> {
    await this.stop(input.sessionId);

    const proxy = await this.ensureProxy();
    const dataDir = path.join(app.getPath("userData"), "sessions", input.sessionId);

    const runtime = await startSession({
      sessionId: input.sessionId,
      dataDir,
      cwd: input.cwd,
      // 传 proxy：key 留在 proxy 内存，pi 的 env 里只有占位值
      proxy: { port: proxy.port, register: (id, target) => proxy.register(id, target) },
      providers: input.providers,
      apiKey: input.apiKey,
      promptSections: input.promptSections,
      tools: input.tools,
      initialPermissionMode: input.initialPermissionMode,
      // 续接上次的上下文（有的话）
      resumeSessionFile: this.options.persistence?.getSessionFile(input.sessionId) ?? null,
      onSessionFile: (file) => {
        try {
          this.options.persistence?.setSessionFile(input.sessionId, file);
        } catch (e) {
          console.error("[db] 记录会话文件失败", e);
        }
      },
      // 权限请求转成事件推给渲染层
      onPermissionRequest: (request) => {
        this.broadcast(input.sessionId, {
          type: "permission_request",
          turnId: "-",
          request,
        });
      },
      onEvent: (event) => this.broadcast(input.sessionId, event),
      log: (level, msg, meta) => {
        if (level === "error") console.error(`[session ${input.sessionId}] ${msg}`, meta ?? "");
        else console.log(`[session ${input.sessionId}] ${msg}`, meta ?? "");
      },
    });

    this.sessions.set(input.sessionId, { runtime, dataDir });
    return { sessionId: input.sessionId, proxyUrl: proxy.url };
  }

  async send(sessionId: string, text: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`会话不存在：${sessionId}`);

    // 先落库再发：即使发送失败，用户输入也不该丢
    try {
      this.options.persistence?.appendMessage({ sessionId, role: "user", content: text });
      this.options.persistence?.maybeAutoTitle(sessionId, text);
    } catch (e) {
      console.error("[db] 存用户消息失败", e);
    }

    await s.runtime.send(text);
  }

  async respondPermission(
    sessionId: string,
    callId: string,
    decision: import("@rakko/shared").PermissionDecision,
  ): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`会话不存在：${sessionId}`);
    await s.runtime.respondPermission(callId, decision);
  }

  async setPermissionMode(
    sessionId: string,
    mode: import("@rakko/shared").PermissionMode,
  ): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`会话不存在：${sessionId}`);
    await s.runtime.setPermissionMode(mode);
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
    this.proxy?.unregister(sessionId);
    await s.runtime.dispose().catch((e: unknown) => {
      console.error(`[session ${sessionId}] dispose 失败`, e);
    });
  }

  async stopAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
    if (this.proxy) {
      await this.proxy.dispose().catch(() => {});
      this.proxy = null;
    }
  }

  getUsage(sessionId: string): TokenUsage | null {
    return this.usage.get(sessionId) ?? null;
  }

  /** 按会话累积当前轮的助手正文，用于在收口时落库 */
  private readonly assistantBuffers = new Map<string, string>();

  private trackAssistantText(sessionId: string, event: AgentEvent): void {
    if (event.type === "turn_start") {
      this.assistantBuffers.set(sessionId, "");
      return;
    }
    if (event.type === "text_delta") {
      const cur = this.assistantBuffers.get(sessionId) ?? "";
      this.assistantBuffers.set(sessionId, cur + event.text);
      return;
    }
    if (event.type === "turn_end") {
      const text = (this.assistantBuffers.get(sessionId) ?? "").trim();
      this.assistantBuffers.delete(sessionId);
      if (!text) return;
      try {
        this.options.persistence?.appendMessage({
          sessionId,
          role: "assistant",
          content: text,
        });
      } catch (e) {
        console.error("[db] 存助手回复失败", e);
      }
    }
  }

  private broadcast(sessionId: string, event: AgentEvent): void {
    // 先落库跟踪，再转发 —— 即使推送失败，数据也在
    this.trackAssistantText(sessionId, event);
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
