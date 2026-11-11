/**
 * 把 AgentEvent 流聚合成可渲染的消息列表。
 *
 * 纯函数，不碰 React，方便单测。
 */
import type { AgentEvent, TokenUsage } from "@rakko/shared";

export interface TextBlock {
  kind: "text";
  text: string;
}

export interface ThinkingBlock {
  kind: "thinking";
  text: string;
}

export interface ToolBlock {
  kind: "tool";
  callId: string;
  name: string;
  input: unknown;
  risk: "low" | "medium" | "high";
  status: "running" | "done" | "error";
  result: string;
  durationMs?: number;
}

export type Block = TextBlock | ThinkingBlock | ToolBlock;

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  blocks: Block[];
  /** 仅 assistant：本轮用量 */
  usage?: TokenUsage;
  /** 仅 assistant：结束原因 */
  endReason?: "done" | "aborted" | "error";
  errorText?: string;
}

/** 一条待处理的审批 */
export interface PendingPermission {
  callId: string;
  toolName: string;
  input: unknown;
  risk: "low" | "medium" | "high";
  summary: string;
  controlPlane: boolean;
}

export interface ChatState {
  messages: ChatMessage[];
  /** 是否有一轮在跑 */
  busy: boolean;
  /** 当前轮 id */
  currentTurnId: string | null;
  /** 累计用量 */
  totalUsage: TokenUsage;
  /** 最近一次错误 */
  lastError: string | null;
  /** 待处理的审批（按到达顺序） */
  pendingPermissions: PendingPermission[];
}

export const initialChatState: ChatState = {
  messages: [],
  busy: false,
  currentTurnId: null,
  totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  lastError: null,
  pendingPermissions: [],
};

/** 用户发消息时立刻本地插入（不等 pi 回显） */
export function appendUserMessage(state: ChatState, text: string): ChatState {
  return {
    ...state,
    lastError: null,
    messages: [
      ...state.messages,
      { id: `u-${state.messages.length}-${Date.now()}`, role: "user", blocks: [{ kind: "text", text }] },
    ],
  };
}

export function reduceEvent(state: ChatState, event: AgentEvent): ChatState {
  switch (event.type) {
    case "turn_start": {
      const msg: ChatMessage = {
        id: `a-${event.turnId}`,
        role: "assistant",
        blocks: [],
      };
      return {
        ...state,
        busy: true,
        currentTurnId: event.turnId,
        lastError: null,
        messages: [...state.messages, msg],
      };
    }

    case "text_delta":
      return updateCurrent(state, (blocks) => {
        const last = blocks[blocks.length - 1];
        if (last && last.kind === "text") {
          const updated: TextBlock = { kind: "text", text: last.text + event.text };
          return [...blocks.slice(0, -1), updated];
        }
        return [...blocks, { kind: "text", text: event.text }];
      });

    case "thinking_delta":
      return updateCurrent(state, (blocks) => {
        const last = blocks[blocks.length - 1];
        if (last && last.kind === "thinking") {
          const updated: ThinkingBlock = { kind: "thinking", text: last.text + event.text };
          return [...blocks.slice(0, -1), updated];
        }
        return [...blocks, { kind: "thinking", text: event.text }];
      });

    case "tool_start":
      return updateCurrent(state, (blocks) => [
        ...blocks,
        {
          kind: "tool",
          callId: event.tool.id,
          name: event.tool.name,
          input: event.tool.input,
          risk: event.tool.risk ?? "high",
          status: "running",
          result: "",
        },
      ]);

    case "tool_end":
      return updateCurrent(state, (blocks) =>
        blocks.map((b) =>
          b.kind === "tool" && b.callId === event.callId
            ? {
                ...b,
                status: event.isError ? ("error" as const) : ("done" as const),
                result: String(event.result ?? ""),
                ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
              }
            : b,
        ),
      );

    case "usage": {
      const total: TokenUsage = {
        inputTokens: state.totalUsage.inputTokens + event.usage.inputTokens,
        outputTokens: state.totalUsage.outputTokens + event.usage.outputTokens,
        cacheReadTokens: state.totalUsage.cacheReadTokens + event.usage.cacheReadTokens,
        cacheWriteTokens: state.totalUsage.cacheWriteTokens + event.usage.cacheWriteTokens,
      };
      return {
        ...state,
        totalUsage: total,
        messages: state.messages.map((m) =>
          m.id === `a-${event.turnId}` ? { ...m, usage: event.usage } : m,
        ),
      };
    }

    case "turn_end":
      return {
        ...state,
        busy: false,
        currentTurnId: null,
        messages: state.messages.map((m) =>
          m.id === `a-${event.turnId}`
            ? { ...m, endReason: event.reason, ...(event.error ? { errorText: event.error } : {}) }
            : m,
        ),
      };

    case "error":
      return { ...state, lastError: event.message, busy: false, currentTurnId: null };

    case "permission_request": {
      const r = event.request;
      // 同 callId 不重复入队（pi 重连或重放时可能出现）
      if (state.pendingPermissions.some((p) => p.callId === r.callId)) return state;
      return {
        ...state,
        pendingPermissions: [
          ...state.pendingPermissions,
          {
            callId: r.callId,
            toolName: r.toolName,
            input: r.input,
            risk: r.risk,
            summary: r.summary,
            controlPlane: r.controlPlane,
          },
        ],
      };
    }

    case "permission_resolved":
    case "tool_update":
      return state;

    default:
      return state;
  }
}

function updateCurrent(state: ChatState, fn: (blocks: Block[]) => Block[]): ChatState {
  const turnId = state.currentTurnId;
  if (!turnId) return state;
  const id = `a-${turnId}`;
  return {
    ...state,
    messages: state.messages.map((m) => (m.id === id ? { ...m, blocks: fn(m.blocks) } : m)),
  };
}

/** 移出一条待审批。用户点了按钮后调用 */
export function clearPendingPermission(state: ChatState, callId: string): ChatState {
  return {
    ...state,
    pendingPermissions: state.pendingPermissions.filter((p) => p.callId !== callId),
  };
}

/** 工具输入压成一行摘要 */
export function summarizeToolInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return clip(input);

  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;

    // 已知字段直接取值，不显示 JSON 花括号与引号
    // 顺序有意义：command 最常见，path 次之
    for (const key of ["command", "path", "file_path", "pattern", "url", "query"]) {
      const v = obj[key];
      if (typeof v === "string" && v.length > 0) {
        // bash 多行命令压成一行预览
        return clip(v.replace(/\s*\n\s*/g, " ⏎ "));
      }
    }

    // 兜底：取第一个字符串值
    for (const v of Object.values(obj)) {
      if (typeof v === "string" && v.length > 0) return clip(v);
    }
  }

  try {
    return clip(JSON.stringify(input));
  } catch {
    return "";
  }
}

function clip(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
