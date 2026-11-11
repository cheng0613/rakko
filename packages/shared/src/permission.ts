/**
 * 权限档。
 *
 * ⚠️ 顺序是硬约束：从严格到宽松，`[0]` 是最严档。
 *
 * 原因：无人值守链路（调度器、自动化）在「显式指定的档位不被支持」时会回落 `[0]`。
 * 如果顺序写反，会把用户选定的更严档**静默放宽成完全访问** —— 这是安全事故，不是显示问题。
 *
 * 由 permission.test.ts 守着，改动前先读测试。
 */
export const PERMISSION_MODES = ["ask", "auto", "bypassPermissions"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** 最严档。任何「不支持则回落」的逻辑都必须落到这个。 */
export const STRICTEST_PERMISSION_MODE: PermissionMode = PERMISSION_MODES[0];

export const PERMISSION_MODE_LABEL: Record<PermissionMode, string> = {
  ask: "每次询问",
  // 诚实标注：真正的自动审核分类器还没做，这一档目前与 ask 相同。
  // 不写「自动审批」是因为那会让用户以为选了就少被打扰。
  auto: "自动审批（待实现）",
  bypassPermissions: "完全访问",
};

export const PERMISSION_MODE_DESCRIPTION: Record<PermissionMode, string> = {
  ask: "每个会改动系统的工具调用都先问你。只读操作直接执行。",
  auto:
    "本应低风险自动放行、高风险才问你。但自动分类器尚未实现，当前行为与「每次询问」相同。",
  bypassPermissions: "不再询问。Agent 可以执行任何命令、读写任何文件。",
};

/**
 * 完全访问档的诚实说明。
 *
 * 我们比 Cindy 强一点：key 不在 spawn env 里，Agent 读环境变量只能读到占位串。
 * 但必须说清代价 —— 它能正常使用模型，也就是能消耗你的额度。
 */
export const BYPASS_WARNING =
  "完全访问下 Agent 可以执行任何命令、读写任何文件。它读不到你的 key（key 只在本地代理里），但可以正常调用模型、消耗额度。";

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * 回落逻辑：给定一个可能非法的值，返回安全的档位。
 * 非法值一律落到最严档，绝不落到最宽档。
 */
export function coercePermissionMode(value: unknown): PermissionMode {
  return isPermissionMode(value) ? value : STRICTEST_PERMISSION_MODE;
}
