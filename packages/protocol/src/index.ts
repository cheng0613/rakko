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

/** 小应用：一份 genui 树 + 名字，打开就能用，不用重新对话 */
export const appSchema = z.object({
  id,
  name: z.string(),
  description: z.string(),
  spec: z.unknown(),
  threadId: id.nullable(),
  createdAt: at,
  updatedAt: at,
});
export type App = z.infer<typeof appSchema>;

/** 应用的某个历史版本（只有 spec 与名字，够回滚） */
export const appVersionSchema = z.object({
  id,
  appId: id,
  name: z.string(),
  description: z.string(),
  spec: z.unknown(),
  createdAt: at,
});
export type AppVersion = z.infer<typeof appVersionSchema>;

export const createAppInput = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(200).optional(),
  spec: z.unknown(),
  threadId: id.optional(),
});
export type CreateAppInput = z.infer<typeof createAppInput>;

export const updateAppInput = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  description: z.string().trim().max(200).optional(),
  spec: z.unknown().optional(),
  /** 应用自己的对话线程：底部输入框把话发到这里 */
  threadId: id.nullable().optional(),
});
export type UpdateAppInput = z.infer<typeof updateAppInput>;

export const messageSchema = z.object({
  id,
  threadId: id,
  /** 会话内序号，从 1 递增；分页用 before=<seq> 往前翻 */
  seq: z.number().int().positive(),
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
  /** 谁触发的：chat / automation / continue */
  source: z.enum(['chat', 'automation', 'continue']),
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

/** 消息分页：默认 30 条，最多 200 条 */
export const messagesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.coerce.number().int().min(1).optional(),
});
export type MessagesQuery = z.infer<typeof messagesQuery>;

/** 分叉：从某条消息起另开一枝 */
export const forkThreadInput = z.object({
  messageId: id,
  /** 默认 false：只复制这条之前的历史（配合「编辑后重跑」） */
  includeTarget: z.boolean().optional(),
  title: z.string().trim().min(1).max(80).optional(),
});
export type ForkThreadInput = z.infer<typeof forkThreadInput>;

export const createThreadInput = z.object({
  title: z.string().min(1).max(120).optional(),
});
export type CreateThreadInput = z.infer<typeof createThreadInput>;

/** 接着一个已经停下的运行继续做；instruction 可覆盖默认的「接着刚才的做」 */
export const continueRunInput = z.object({
  instruction: z.string().min(1).max(2000).optional(),
});
export type ContinueRunInput = z.infer<typeof continueRunInput>;

export const updateThreadInput = z.object({
  // 先 trim 再判空：只输空格不算有效标题
  title: z.string().trim().min(1).max(120),
});
export type UpdateThreadInput = z.infer<typeof updateThreadInput>;

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
  /** once = 只这一次；always = 这类工具以后不再问 */
  scope: z.enum(['once', 'always']).optional(),
  reason: z.string().max(500).optional(),
});
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;

export const riskLevelSchema = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

/** 技能：一段可挂载的规则，挂上之后每次运行都会带进系统提示 */
export const skillSchema = z.object({
  id,
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  body: z.string(),
  /** 内置技能不可删，但可以关掉 */
  builtin: z.boolean(),
  /** 这个技能允许的工具名；空数组 = 不限制 */
  tools: z.array(z.string()).default([]),
  createdAt: at,
});
export type Skill = z.infer<typeof skillSchema>;

export const createSkillInput = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).optional(),
  body: z.string().min(1).max(8000),
  /** 只允许这些工具；不给就不限制 */
  tools: z.array(z.string().trim().min(1)).max(20).optional(),
});
export type CreateSkillInput = z.infer<typeof createSkillInput>;

export const updateSkillInput = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(200).optional(),
  body: z.string().min(1).max(8000).optional(),
  tools: z.array(z.string().trim().min(1)).max(20).optional(),
});
export type UpdateSkillInput = z.infer<typeof updateSkillInput>;

/** 记忆：值得跨会话留下的四类东西 */
export const MEMORY_KINDS = ['user', 'feedback', 'project', 'reference'] as const;
export const memoryKindSchema = z.enum(MEMORY_KINDS);
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_STATUSES = ['active', 'pending'] as const;
export const memoryStatusSchema = z.enum(MEMORY_STATUSES);
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const memorySchema = z.object({
  id,
  kind: memoryKindSchema,
  /** active = 已生效；pending = 自动提取、等确认 */
  status: memoryStatusSchema.default('active'),
  title: z.string(),
  description: z.string(),
  body: z.string(),
  createdAt: at,
  updatedAt: at,
});
export type Memory = z.infer<typeof memorySchema>;

/** 知识图谱：节点与边 */
export const kgNodeSchema = z.object({
  id,
  name: z.string(),
  kind: z.string(),
  memoryId: id.nullable(),
  createdAt: at,
});
export type KgNode = z.infer<typeof kgNodeSchema>;

export const kgEdgeSchema = z.object({
  id,
  fromId: id,
  toId: id,
  relation: z.string(),
  memoryId: id.nullable(),
  createdAt: at,
});
export type KgEdge = z.infer<typeof kgEdgeSchema>;

export const graphSchema = z.object({
  nodes: z.array(kgNodeSchema),
  edges: z.array(kgEdgeSchema),
});
export type Graph = z.infer<typeof graphSchema>;

export const createMemoryInput = z.object({
  kind: memoryKindSchema,
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(200).optional(),
  body: z.string().min(1).max(8000),
});
export type CreateMemoryInput = z.infer<typeof createMemoryInput>;

export const updateMemoryInput = z.object({
  kind: memoryKindSchema.optional(),
  status: memoryStatusSchema.optional(),
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(200).optional(),
  body: z.string().min(1).max(8000).optional(),
});
export type UpdateMemoryInput = z.infer<typeof updateMemoryInput>;

/** 自动化：一条 cron + 一句任务描述，到点就起一个运行 */
export const automationSchema = z.object({
  id,
  name: z.string(),
  schedule: z.string(),
  prompt: z.string(),
  /** 作用到哪个小应用；null 表示每次开新会话 */
  appId: id.nullable(),
  enabled: z.boolean(),
  lastRunAt: at.nullable(),
  createdAt: at,
});
export type Automation = z.infer<typeof automationSchema>;

export const createAutomationInput = z.object({
  name: z.string().trim().min(1).max(80),
  /** 五段 cron：分 时 日 月 周 */
  schedule: z.string().trim().min(1).max(60),
  prompt: z.string().min(1).max(4000),
  enabled: z.boolean().optional(),
  appId: id.optional(),
});
export type CreateAutomationInput = z.infer<typeof createAutomationInput>;

export const updateAutomationInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  schedule: z.string().trim().min(1).max(60).optional(),
  prompt: z.string().min(1).max(4000).optional(),
  enabled: z.boolean().optional(),
  appId: id.nullable().optional(),
});
export type UpdateAutomationInput = z.infer<typeof updateAutomationInput>;

/** 用户设置：目前只有「用超了怎么办」，以后加别的都进这个对象 */
export const settingsSchema = z.object({
  degradeOnExceed: z.boolean(),
  /** 用户点过「允许这类」的工具，之后不再问 */
  approvedTools: z.array(z.string()).default([]),
  /** 挂载中的技能 slug：内容会被拼进系统提示 */
  enabledSkills: z.array(z.string()).default([]),
  /** 运行成功后自动提取记忆（默认开） */
  autoExtractMemory: z.boolean().default(true),
});
export type Settings = z.infer<typeof settingsSchema>;

export const updateSettingsInput = z.object({
  degradeOnExceed: z.boolean().optional(),
  approvedTools: z.array(z.string()).optional(),
  enabledSkills: z.array(z.string()).optional(),
  autoExtractMemory: z.boolean().optional(),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsInput>;

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
