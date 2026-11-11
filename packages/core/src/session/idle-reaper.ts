/**
 * 空闲会话回收。
 *
 * 为什么需要：`pi --mode rpc` 每个会话约 100–300MB（我们实测 ~100MB）。
 * 用户开几个会话挂着不动，内存就累积上去了。Cindy 的记录里
 * 这是上游 issue #5830。
 *
 * 设计（照 Cindy 的参数）：
 *   - TTL 30 分钟：超过这么久没活动就回收
 *   - 每 5 分钟扫一次
 *
 * 回收不等于删除：会话数据（消息、session_file）都在数据库里，
 * 下次发消息时按 session_file 续接上下文，与冷启动一致。
 * 代价是闲置后的第一次发消息要多等一次冷启动。
 *
 * **释放前必须复查**：
 *   - 是否有回合在跑
 *   - 是否有待审批
 *   - 读一次最新的活动时间再比对阈值（避免扫描期间刚好有人发消息）
 */

export interface IdleSessionInfo {
  sessionId: string;
  /** 最后一次活动时间（毫秒时间戳） */
  lastActiveAt: number;
  /** 是否正在跑回合 / 有待审批 —— 这类不能回收 */
  busy: boolean;
}

export interface ReaperOptions {
  /** 列出当前所有会话 */
  listSessions: () => IdleSessionInfo[];
  /** 关闭一个会话（不影响数据库） */
  closeSession: (sessionId: string) => Promise<void>;
  /** 空闲阈值，默认 30 分钟 */
  ttlMs?: number;
  /** 扫描间隔，默认 5 分钟 */
  scanIntervalMs?: number;
  /** 现在的时间，测试可注入 */
  now?: () => number;
  log?: (level: "info" | "warn", msg: string, meta?: unknown) => void;
}

export const DEFAULT_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_SCAN_INTERVAL_MS = 5 * 60 * 1000;

export class IdleReaper {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly options: ReaperOptions) {}

  /** 给日志用 */
  get ttlMsForLog(): number {
    return this.ttlMs;
  }
  get scanIntervalMsForLog(): number {
    return this.scanIntervalMs;
  }

  private get ttlMs(): number {
    return this.options.ttlMs ?? DEFAULT_TTL_MS;
  }

  private get scanIntervalMs(): number {
    return this.options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * 扫一次，返回被回收的会话 id。
   *
   * 单独暴露出来是为了能测：不用等 5 分钟。
   */
  async scanOnce(): Promise<string[]> {
    // 上一轮还没跑完就跳过，避免重入导致重复 close
    if (this.running) return [];
    this.running = true;

    const closed: string[] = [];
    try {
      const now = this.now();
      const sessions = this.options.listSessions();

      for (const s of sessions) {
        if (s.busy) continue;

        const idle = now - s.lastActiveAt;
        if (idle < this.ttlMs) continue;

        // 释放前复查：扫描期间可能刚好有人发消息。
        // listSessions 每次调用都返回当前真实状态，所以要重新取一遍。
        const fresh = this.options.listSessions().find((x) => x.sessionId === s.sessionId);
        if (!fresh) continue; // 已经被别处关了
        if (fresh.busy) continue;
        if (this.now() - fresh.lastActiveAt < this.ttlMs) continue;

        try {
          await this.options.closeSession(s.sessionId);
          closed.push(s.sessionId);
          this.options.log?.("info", "回收空闲会话", {
            sessionId: s.sessionId,
            idleMinutes: Math.round(idle / 60_000),
          });
        } catch (e) {
          this.options.log?.("warn", "回收失败", {
            sessionId: s.sessionId,
            message: (e as Error).message,
          });
        }
      }
    } finally {
      this.running = false;
    }

    return closed;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.scanOnce();
    }, this.scanIntervalMs);
    // 不要因为一个定时器让进程无法退出
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
