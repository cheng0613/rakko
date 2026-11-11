/**
 * 主进程 ↔ 渲染进程的 IPC 契约。
 *
 * 只放类型，不放实现。preload 与 renderer 都 import 这里，保证两端签名一致。
 */
import type { AgentEvent, PermissionDecision } from "./agent-event.js";
import type { PermissionMode } from "./permission.js";

export interface ProjectInfo {
  id: string;
  name: string;
  cwd: string;
  lastOpenedAt: number;
}

export interface SessionInfo {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface SendMessageInput {
  sessionId: string;
  text: string;
}

/** 启动一个会话 */
export interface StartSessionInput {
  sessionId: string;
  cwd: string;
  /** 系统提示追加段落 */
  promptSections: string[];
  /** 工具：具体名单，或 "all" 开启默认集 */
  tools: string[] | "all";
}

/**
 * 渲染进程可见的模型信息。
 * 不包含 key、不包含真实 baseUrl —— 那些只在主进程里。
 */
export interface ModelSummary {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  contextWindow: number;
}

export interface PermissionResolveInput {
  sessionId: string;
  callId: string;
  decision: PermissionDecision;
}

export interface SetPermissionModeInput {
  sessionId: string;
  mode: PermissionMode;
}

/**
 * 事件订阅的取消函数。
 * 事件流是可订阅的 pub/sub —— translator 不直接 webContents.send，
 * 这样将来加手机推送 / IM 转发时不用改翻译层。
 */
export type Unsubscribe = () => void;

export interface RakkoApi {
  /** 列出已登记的项目 */
  listProjects(): Promise<ProjectInfo[]>;

  /** 打开（或新建）一个项目 */
  openProject(cwd: string): Promise<ProjectInfo>;

  /** 列出某个项目的会话 */
  listSessions(projectId: string): Promise<SessionInfo[]>;

  /** 在一个项目里新建会话 */
  createSession(projectId: string): Promise<SessionInfo>;

  /** 启动/重启一个会话运行时 */
  startSession(input: StartSessionInput): Promise<{ sessionId: string }>;

  /** 停止会话 */
  stopSession(sessionId: string): Promise<void>;

  /** 发消息 */
  sendMessage(input: SendMessageInput): Promise<void>;

  /** 中止当前轮次 */
  abort(sessionId: string): Promise<void>;

  /** 回答权限询问 */
  resolvePermission(input: PermissionResolveInput): Promise<void>;

  /** 切换权限档 */
  setPermissionMode(input: SetPermissionModeInput): Promise<void>;

  /** 订阅某个会话的 Agent 事件 */
  onAgentEvent(sessionId: string, handler: (event: AgentEvent) => void): Unsubscribe;

  /**
   * 列出可用模型（只含展示信息）。
   * 真正的 key 与上游地址只在主进程，不下发。
   */
  listModels(): Promise<ModelSummary[]>;

  /** 应用配置（目前只有产品名与版本，给窗口标题用） */
  getAppInfo(): Promise<{ name: string; version: string }>;
}

/** IPC 通道名，集中定义避免两端写错字符串。 */
export const IPC = {
  listProjects: "rakko:list-projects",
  openProject: "rakko:open-project",
  listSessions: "rakko:list-sessions",
  createSession: "rakko:create-session",
  startSession: "rakko:start-session",
  stopSession: "rakko:stop-session",
  sendMessage: "rakko:send-message",
  abort: "rakko:abort",
  resolvePermission: "rakko:resolve-permission",
  setPermissionMode: "rakko:set-permission-mode",
  agentEvent: "rakko:agent-event",
  getAppInfo: "rakko:get-app-info",
  listModels: "rakko:list-models",
} as const;
