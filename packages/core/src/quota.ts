/**
 * 配额按「运行次数」计。用超了不硬停 —— 按设置降级到快模型继续跑，任务不中断。
 *
 * 这里是配额的唯一规则来源：服务端只负责把「本月已用次数」数出来，
 * 上限、周期、降级与否全部由本文件决定。
 */

import type { RunState } from '@rakko/protocol';

export interface QuotaState {
  limit: number;
  used: number;
  degradeOnExceed: boolean;
}

export type QuotaDecision =
  | { kind: 'allow'; remaining: number }
  | { kind: 'degrade'; remaining: 0; reason: string }
  | { kind: 'block'; remaining: 0; reason: string };

/** 各计划的每周运行次数上限。改了这里就是改了产品定价。 */
export const PLAN_LIMITS = { free: 30, pro: 120, team: 600 } as const;

export type PlanId = keyof typeof PLAN_LIMITS;

export function planLimit(plan: string): number {
  return PLAN_LIMITS[plan as PlanId] ?? PLAN_LIMITS.free;
}

export function remainingQuota(state: QuotaState): number {
  return Math.max(0, state.limit - state.used);
}

export function decideQuota(state: QuotaState): QuotaDecision {
  const remaining = remainingQuota(state);
  if (remaining > 0) return { kind: 'allow', remaining };
  if (state.degradeOnExceed) {
    return { kind: 'degrade', remaining: 0, reason: '本周次数已用完，改用快速模型继续，任务不中断' };
  }
  return { kind: 'block', remaining: 0, reason: '本周次数已用完，下月 1 日重置' };
}

/** 一句中文描述当前配额状态，给 UI 层直接展示。 */
export function describeQuota(state: QuotaState): string {
  const remaining = remainingQuota(state);
  if (remaining > 0) return `剩余 ${remaining} 次，可继续运行`;
  if (state.degradeOnExceed) return '本周次数已用完，将降级到快速模型继续';
  return '本周次数已用完，新任务将被拦截';
}

/** 只有真正跑起来的运行才计数：排队中取消不扣次。 */
export function shouldChargeRun(state: RunState): boolean {
  return state !== 'canceled';
}

/** YYYY-MM，与 usage_ledger.period 对应，也是重置边界的唯一写法。 */
export function currentPeriod(at: Date = new Date()): string {
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/** 本周期起点，用于「下月 1 日重置」这句话。 */
export function periodStart(at: Date = new Date()): string {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
}
