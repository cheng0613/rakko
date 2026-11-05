/**
 * Rakko 通信协议 —— 服务端、桌面端、移动端共用的唯一契约。
 *
 * 这里定义的每个 schema 都同时是：运行时校验、TypeScript 类型、以及 SSE 载荷的文档。
 * 改这里等于改协议版本，客户端必须同步。
 */

import { z } from 'zod';

/** 一次运行的生命周期。终态之后不接受任何事件。 */
export const RUN_STATES = [
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'canceled',
] as const;

export const runStateSchema = z.enum(RUN_STATES);
export type RunState = (typeof RUN_STATES)[number];

/** 终态集合：落库后可结算配额、可被清理。 */
export const TERMINAL_STATES: readonly RunState[] = ['succeeded', 'failed', 'canceled'];

const id = z.string().min(1);
const at = z.string().min(1);

export const runEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.started'), runId: id, at }),
  z.object({ type: z.literal('run.delta'), runId: id, at, text: z.string() }),
  /** 模型的思考过程；只用于展示「正在想」，不能拼进回答 */
  z.object({ type: z.literal('run.reasoning'), runId: id, at, text: z.string() }),
  /** 主模型不可用，已降级到快模型 */
  z.object({
    type: z.literal('run.fallback'),
    runId: id,
    at,
    from: z.string(),
    to: z.string(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal('run.tool_call'),
    runId: id,
    at,
    callId: id,
    name: id,
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('run.tool_result'),
    runId: id,
    at,
    callId: id,
    ok: z.boolean(),
    output: z.string(),
  }),
  /** 高风险工具需要人来点一下 */
  z.object({
    type: z.literal('run.approval_requested'),
    runId: id,
    at,
    callId: id,
    name: id,
    risk: z.enum(['low', 'medium', 'high']),
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('run.approval_decided'),
    runId: id,
    at,
    callId: id,
    decision: z.enum(['allow', 'deny']),
    reason: z.string().optional(),
  }),
  z.object({ type: z.literal('run.state'), runId: id, at, state: runStateSchema }),
  z.object({ type: z.literal('run.error'), runId: id, at, message: z.string(), code: z.string().optional() }),
  z.object({ type: z.literal('run.done'), runId: id, at, state: runStateSchema }),
]);

export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventType = RunEvent['type'];

export const threadSchema = z.object({
  id,
  title: z.string(),
  createdAt: at,
  updatedAt: at,
});
export type Thread = z.infer<typeof threadSchema>;

export const messageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool']);
export type MessageRole = z.infer<typeof messageRoleSchema>;

/**
 * 会话里的一条记录。text 只是其中一种：
 * 工具调用、工具结果、审批请求、审批结论、降级提示都要能重放，否则重开会话就只剩文字。
 */
export const MESSAGE_KINDS = [
  'text',
  'tool_call',
  'tool_result',
  'approval',
  'approval_decision',
  'notice',
] as const;

export const messageKindSchema = z.enum(MESSAGE_KINDS);
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const messageSchema = z.object({
  id,
  threadId: id,
  role: messageRoleSchema,
  kind: messageKindSchema,
  text: z.string(),
  /** 非文本消息的结构化内容：工具参数、结果、审批结论等 */
  payload: z.record(z.string(), z.unknown()).nullable(),
  runId: id.nullable(),
  createdAt: at,
});
export type Message = z.infer<typeof messageSchema>;

export const runSchema = z.object({
  id,
  threadId: id,
  state: runStateSchema,
  model: z.string(),
  prompt: z.string(),
  error: z.string().nullable(),
  createdAt: at,
  finishedAt: at.nullable(),
});
export type Run = z.infer<typeof runSchema>;

/** 配额按「运行次数」计，不按 token —— 用户能算得清。 */
export const usageSchema = z.object({
  plan: z.string(),
  limit: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  periodStart: at,
  degradeOnExceed: z.boolean(),
});
export type Usage = z.infer<typeof usageSchema>;

export const createThreadInput = z.object({
  title: z.string().min(1).max(120).optional(),
});
export type CreateThreadInput = z.infer<typeof createThreadInput>;

export const createRunInput = z.object({
  threadId: id,
  prompt: z.string().min(1).max(20000),
  model: z.string().min(1).optional(),
});
export type CreateRunInput = z.infer<typeof createRunInput>;

export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  issues: z.array(z.unknown()).optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** 审批：人只能给 allow / deny，不能顺手改参数。 */
export const approvalDecisionSchema = z.object({
  decision: z.enum(['allow', 'deny']),
  reason: z.string().max(500).optional(),
});
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;

export const riskLevelSchema = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

/** 前端轮询 / 刷新后恢复审批卡片用 */
export const pendingApprovalSchema = z.object({
  runId: id,
  callId: id,
  name: z.string(),
  risk: riskLevelSchema,
  args: z.record(z.string(), z.unknown()),
  requestedAt: at,
  expiresAt: at,
});
export type PendingApproval = z.infer<typeof pendingApprovalSchema>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/** SSE 一行一个 JSON：坏包不能把整条流打断，只丢掉这一条。 */
export function parseRunEvent(input: unknown): Parsed<RunEvent> {
  const result = runEventSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, reason: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
}

export function serializeRunEvent(event: RunEvent): string {
  return JSON.stringify(runEventSchema.parse(event));
}
