/**
 * 单 provider 起步，所以熔断是唯一的安全网：上游挂了就开门，别把请求全砸过去。
 */

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
  /** 连续失败多少次开门 */
  failureThreshold?: number;
  /** 开门后静默多久再放一个探针 */
  cooldownMs?: number;
  now?: () => number;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private probing = false;

  constructor(options: BreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
  }

  getState(): BreakerState {
    this.maybeHalfOpen();
    return this.state;
  }

  /** 半开状态只放行一个探针，其余继续拒绝，避免恢复瞬间被压垮。 */
  canPass(): boolean {
    this.maybeHalfOpen();
    if (this.state === 'closed') return true;
    if (this.state === 'open') return false;
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  recordSuccess(): void {
    this.state = 'closed';
    this.failures = 0;
    this.probing = false;
    this.openedAt = 0;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.state === 'half_open' || this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
    this.probing = false;
  }

  private maybeHalfOpen(): void {
    if (this.state !== 'open') return;
    if (this.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half_open';
      this.probing = false;
    }
  }
}
