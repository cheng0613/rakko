/**
 * pi 的 RPC 事件 → 统一 AgentEvent。
 *
 * 全部映射规则来自实测（pi 1.4.0，见 AGENTS.md 第六节），不是照文档猜的。
 * 实测到的事件类型：
 *
 *   response        RPC 命令回执，不是对话事件
 *   agent_start     一轮开始
 *   turn_start      当前这轮
 *   message_start   system 消息（含 sections）
 *   message_update  增量：assistantMessageEvent 里有 text_start/text_delta/thinking_*
 *   tool_execution_start / tool_execution_end
 *   turn_end        带完整 assistant message 与 usage
 *   agent_end       整轮结束
 *   agent_settled   最终结束（aborted 标记取消）
 *
 * 注意：message_update 的 usage 是累计值，不是增量。
 */
import type { AgentEvent, TokenUsage } from "@rakko/shared";

/** pi 原始事件（只声明我们用到的字段） */
export interface PiRawEvent {
  type: string;
  [key: string]: unknown;
}

interface AssistantMessageEvent {
  type: string;
  delta?: string;
  contentIndex?: number;
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface PiToolResult {
  content?: Array<{ type: string; text?: string }>;
  [key: string]: unknown;
}

/**
 * translator 状态。每个会话一个实例。
 */
export class PiTranslator {
  private currentTurnId: string | null = null;
  private turnSeq = 0;

  constructor(private readonly onEvent: (event: AgentEvent) => void) {}

  /** 当前轮次 id，供外部排查用 */
  get turnId(): string | null {
    return this.currentTurnId;
  }

  handle(raw: PiRawEvent): void {
    switch (raw.type) {
      case "agent_start":
        this.startTurn();
        break;

      case "turn_start":
        // agent_start 已经建过轮次了，这里不重复
        if (!this.currentTurnId) this.startTurn();
        break;

      case "message_update":
        this.handleMessageUpdate(raw);
        break;

      case "tool_execution_start":
        this.handleToolStart(raw);
        break;

      case "tool_execution_end":
        this.handleToolEnd(raw);
        break;

      case "turn_end":
        this.handleTurnEnd(raw);
        break;

      case "agent_settled": {
        const aborted = raw["aborted"] === true;
        this.endTurn(aborted ? "aborted" : "done");
        break;
      }

      case "error": {
        const message = typeof raw["message"] === "string" ? raw["message"] : "未知错误";
        this.emit({ type: "error", message, recoverable: raw["recoverable"] === true });
        break;
      }

      // response / message_start / message_end / agent_end 不产生 UI 事件
      default:
        break;
    }
  }

  private startTurn(): void {
    this.turnSeq += 1;
    this.currentTurnId = `t${this.turnSeq}`;
    this.emit({ type: "turn_start", turnId: this.currentTurnId });
  }

  private handleMessageUpdate(raw: PiRawEvent): void {
    if (!this.currentTurnId) return;

    const inner = raw["assistantMessageEvent"] as AssistantMessageEvent | undefined;
    if (inner) {
      switch (inner.type) {
        case "text_delta":
          if (typeof inner.delta === "string" && inner.delta.length > 0) {
            this.emit({ type: "text_delta", turnId: this.currentTurnId, text: inner.delta });
          }
          return;
        case "thinking_delta":
          if (typeof inner.delta === "string" && inner.delta.length > 0) {
            this.emit({ type: "thinking_delta", turnId: this.currentTurnId, text: inner.delta });
          }
          return;
        // text_start / text_end / thinking_start / thinking_end 不需要单独事件
        default:
          return;
      }
    }

    // 有时 usage 挂在 message_update 顶层，作为累计值
    const usage = raw["usage"] as PiUsage | undefined;
    if (usage) {
      this.emit({ type: "usage", turnId: this.currentTurnId, usage: normalizeUsage(usage) });
    }
  }

  private handleToolStart(raw: PiRawEvent): void {
    if (!this.currentTurnId) return;
    const callId = String(raw["toolCallId"] ?? "");
    const name = String(raw["toolName"] ?? "");
    if (!callId || !name) return;

    this.emit({
      type: "tool_start",
      turnId: this.currentTurnId,
      tool: {
        id: callId,
        name,
        input: raw["args"] ?? null,
        risk: classifyToolRisk(name),
      },
    });
  }

  private handleToolEnd(raw: PiRawEvent): void {
    if (!this.currentTurnId) return;
    const callId = String(raw["toolCallId"] ?? "");
    if (!callId) return;

    const result = raw["result"] as PiToolResult | undefined;
    const durationMs = typeof raw["durationMs"] === "number" ? raw["durationMs"] : undefined;

    this.emit({
      type: "tool_end",
      turnId: this.currentTurnId,
      callId,
      result: extractToolText(result),
      isError: raw["isError"] === true,
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
  }

  private handleTurnEnd(raw: PiRawEvent): void {
    if (!this.currentTurnId) return;

    const message = raw["message"] as { usage?: PiUsage } | undefined;
    if (message?.usage) {
      this.emit({
        type: "usage",
        turnId: this.currentTurnId,
        usage: normalizeUsage(message.usage),
      });
    }
  }

  private endTurn(reason: "done" | "aborted" | "error", error?: string): void {
    if (!this.currentTurnId) return;
    const turnId = this.currentTurnId;
    this.currentTurnId = null;
    this.emit({ type: "turn_end", turnId, reason, ...(error ? { error } : {}) });
  }

  /**
   * 外部主动中止时调用（用户点了停止）。
   * 不等 pi 的 agent_settled，先收口，避免 UI 卡在运行中。
   */
  abortTurn(): void {
    this.endTurn("aborted");
  }

  private emit(event: AgentEvent): void {
    this.onEvent(event);
  }
}

function normalizeUsage(u: PiUsage): TokenUsage {
  return {
    inputTokens: num(u.input),
    outputTokens: num(u.output),
    cacheReadTokens: num(u.cacheRead),
    cacheWriteTokens: num(u.cacheWrite),
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 把工具结果压成纯文本，UI 只显示文本，结构化部分暂不展示 */
/** 工具输出上限。超过就截断，避免长命令把 DOM 撑爆 */
const TOOL_OUTPUT_LIMIT = 32_000;

/**
 * 去掉终端 ANSI 转义序列。
 *
 * dogfood 实测：`npx vitest` 的输出带 `\u001b[31m` 之类的颜色码，
 * 直接显示在界面上是不可见字符，或者变成乱码。
 *
 * 覆盖：CSI（颜色、光标）、OSC（超链接、标题）、以及零散的 ESC 序列。
 */
export function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\\\)/g, "")
    .replace(/\u001b[@-Z\\\\-_]/g, "")
    .replace(/\r\n/g, "\n");
}

function extractToolText(result: PiToolResult | undefined): string {
  if (!result) return "";

  const raw = (() => {
    const content = result.content;
    if (!Array.isArray(content)) return JSON.stringify(result);
    return content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
  })();

  const clean = stripAnsi(raw);

  if (clean.length <= TOOL_OUTPUT_LIMIT) return clean;
  // 保留开头与结尾：头通常是上下文，尾通常是结论/报错
  const head = clean.slice(0, TOOL_OUTPUT_LIMIT - 5000);
  const tail = clean.slice(-4500);
  return `${head}\n\n…（中间省略 ${clean.length - TOOL_OUTPUT_LIMIT} 字符）…\n\n${tail}`;
}

/**
 * 工具风险分级。决定 default 权限档下是否需要弹审批。
 *
 * 保守原则：拿不准就标 high，宁可多问一次。
 */
export function classifyToolRisk(name: string): "low" | "medium" | "high" {
  const lower = name.toLowerCase();

  // 只读
  if (["read", "ls", "grep", "find", "glob"].includes(lower)) return "low";

  // 会改文件
  if (["write", "edit", "apply_patch", "patch"].includes(lower)) return "high";

  // 执行命令
  if (["bash", "shell", "powershell", "exec", "run"].includes(lower)) return "high";

  // 网络与其他
  if (["fetch", "http", "web"].includes(lower)) return "medium";

  return "high";
}
