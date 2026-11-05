/**
 * 审批闸门：把「运行」挂起，等人点一下。
 *
 * 没有审批人时不会永远挂着 —— 到点自动拒绝，运行继续往下跑，
 * 模型会收到「用户没允许」并换个做法，而不是整条运行烂在那里。
 */

import type { PendingApproval, RiskLevel } from '@rakko/protocol';

export interface ApprovalRequestInput {
  runId: string;
  callId: string;
  name: string;
  risk: RiskLevel;
  args: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ApprovalDecision {
  decision: 'allow' | 'deny';
  reason?: string;
}

export interface ApprovalGateOptions {
  /** 默认 10 分钟 */
  timeoutMs?: number;
  now?: () => number;
}

const key = (runId: string, callId: string): string => `${runId}:${callId}`;

export class ApprovalGate {
  private readonly pending = new Map<
    string,
    { entry: PendingApproval; resolve: (decision: ApprovalDecision) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: ApprovalGateOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.pending.size;
  }

  request(input: ApprovalRequestInput): Promise<ApprovalDecision> {
    const timeoutMs = input.timeoutMs ?? this.timeoutMs;
    const requestedAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + timeoutMs).toISOString();

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(key(input.runId, input.callId));
        resolve({ decision: 'deny', reason: `等不到审批（${Math.round(timeoutMs / 1000)} 秒），这次调用没有执行` });
      }, timeoutMs);

      this.pending.set(key(input.runId, input.callId), {
        entry: {
          runId: input.runId,
          callId: input.callId,
          name: input.name,
          risk: input.risk,
          args: input.args,
          requestedAt,
          expiresAt,
        },
        resolve,
        timer,
      });
    });
  }

  /** 返回 false 表示这条审批已经不存在（重复点、已超时） */
  decide(runId: string, callId: string, decision: ApprovalDecision): boolean {
    const record = this.pending.get(key(runId, callId));
    if (!record) return false;
    clearTimeout(record.timer);
    this.pending.delete(key(runId, callId));
    record.resolve(decision);
    return true;
  }

  list(runId: string): PendingApproval[] {
    return [...this.pending.values()]
      .filter((record) => record.entry.runId === runId)
      .map((record) => record.entry);
  }

  /** 运行被取消时，把所有等待中的审批一并拒掉 */
  cancelRun(runId: string, reason = '运行已取消，审批作废'): number {
    let count = 0;
    for (const [entryKey, record] of this.pending) {
      if (record.entry.runId !== runId) continue;
      clearTimeout(record.timer);
      this.pending.delete(entryKey);
      record.resolve({ decision: 'deny', reason });
      count += 1;
    }
    return count;
  }

  cancelAll(reason = '服务正在退出，审批作废'): number {
    let count = 0;
    for (const [entryKey, record] of this.pending) {
      clearTimeout(record.timer);
      this.pending.delete(entryKey);
      record.resolve({ decision: 'deny', reason });
      count += 1;
    }
    return count;
  }
}
