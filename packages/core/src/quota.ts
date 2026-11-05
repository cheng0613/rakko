/**
 * 配额按「运行次数」计。用超了不硬停 —— 按设置降级到快模型继续跑，任务不中断。
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

/** 只有真正跑起来的运行才计数：排队中取消不扣次。 */
export function shouldChargeRun(state: RunState): boolean {
  return state !== 'canceled';
}
