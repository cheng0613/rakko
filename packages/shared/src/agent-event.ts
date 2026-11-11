/**
 * 统一 Agent 事件模型。
 *
 * UI 只消费这一层，不直接消费 pi 的原始事件。pi 的事件形态会随版本变化
 * （实测 1.4.0 与文档描述的字段名就有差异），translator 负责把它翻译成这里的形状。
 *
 * 首期只有 pi 一个 harness，不做多引擎抽象；但如果将来要接第二个引擎，
 * 只需新增一个 translator，UI 不动。
 */

export type ToolRisk = "low" | "medium" | "high";

export interface ToolCallInfo {
  id: string;
  name: string;
  input: unknown;
  risk?: ToolRisk;
}

export interface PermissionRequest {
  /** 与 tool_start 的 id 对应，也是 extension_ui_request 的 id */
  callId: string;
  toolName: string;
  input: unknown;
  risk: ToolRisk;
  /** 展示用摘要，由主进程生成，避免 renderer 重复实现 */
  summary: string;
  /**
   * 是否属于控制面：改的是 agentHome 里的 models.json / 权限档等应用配置。
   * 这类写入即使在完全访问档下也必须询问 —— 模型改写 models.json 的 baseUrl
   * 就能把后续请求劫持到别的 endpoint。
   */
  controlPlane: boolean;
  /**
   * 是否触碰凭证路径（.ssh / .env / .aws 等）。
   * 只读工具碰到这类路径也会升级为审批 —— 防止 agent 静默读 key。
   */
  credential?: boolean;
}

export type PermissionDecision = "allow-once" | "allow-type" | "deny";

export type AgentEvent =
  | { type: "turn_start"; turnId: string }
  | { type: "text_delta"; turnId: string; text: string }
  | { type: "thinking_delta"; turnId: string; text: string }
  | { type: "tool_start"; turnId: string; tool: ToolCallInfo }
  | { type: "tool_update"; turnId: string; callId: string; partial: string }
  | {
      type: "tool_end";
      turnId: string;
      callId: string;
      result: unknown;
      isError: boolean;
      durationMs?: number;
    }
  | { type: "permission_request"; turnId: string; request: PermissionRequest }
  | { type: "permission_resolved"; turnId: string; callId: string; decision: PermissionDecision }
  | { type: "usage"; turnId: string; usage: TokenUsage }
  | { type: "turn_end"; turnId: string; reason: "done" | "aborted" | "error"; error?: string }
  | { type: "error"; message: string; recoverable: boolean };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
