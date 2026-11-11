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
}

export const initialChatState: ChatState = {
  messages: [],
  busy: false,
  currentTurnId: null,
  totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  lastError: null,
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

    case "permission_request":
      // P0 步骤 11 才接审批，这里先记一笔
      return { ...state, lastError: "收到权限请求，但审批界面还没实现" };

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

/** 工具输入压成一行摘要 */
export function summarizeToolInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input.slice(0, 200);
  try {
    const s = JSON.stringify(input);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return "";
  }
}
