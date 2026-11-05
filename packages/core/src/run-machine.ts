/**
 * 运行状态机。任何状态变更都必须走这里 —— 服务端不允许直接写 state 字段。
 */

import type { RunState } from '@rakko/protocol';
import { TERMINAL_STATES } from '@rakko/protocol';

export const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ['running', 'canceled'],
  running: ['waiting_approval', 'succeeded', 'failed', 'canceled'],
  waiting_approval: ['running', 'failed', 'canceled'],
  succeeded: [],
  failed: [],
  canceled: [],
};

export function isTerminal(state: RunState): boolean {
  return (TERMINAL_STATES as readonly RunState[]).includes(state);
}

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransition extends Error {
  constructor(from: RunState, to: RunState) {
    super(`运行状态不能从 ${from} 变到 ${to}`);
    this.name = 'IllegalTransition';
  }
}

/** 非法变更抛错而不是静默丢弃：静默会把「卡住的运行」藏起来。 */
export function assertTransition(from: RunState, to: RunState): RunState {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
  return to;
}

/** 状态机只管合法性，重试与降级由 provider 层决定。 */
export function nextStateAfterFailure(retryable: boolean): RunState {
  return retryable ? 'queued' : 'failed';
}
