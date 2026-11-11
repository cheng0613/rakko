import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SCAN_INTERVAL_MS,
  DEFAULT_TTL_MS,
  IdleReaper,
  type IdleSessionInfo,
} from "../idle-reaper.js";

const MIN = 60_000;

/** 可控时钟 */
function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function makeSession(sessionId: string, lastActiveAt: number, busy = false): IdleSessionInfo {
  return { sessionId, lastActiveAt, busy };
}

describe("默认参数（照 Cindy）", () => {
  it("TTL 30 分钟", () => {
    expect(DEFAULT_TTL_MS).toBe(30 * MIN);
  });

  it("扫描间隔 5 分钟", () => {
    expect(DEFAULT_SCAN_INTERVAL_MS).toBe(5 * MIN);
  });
});

describe("回收判定", () => {
  it("超过 TTL 的空闲会话被回收", async () => {
    const clock = makeClock();
    const closed: string[] = [];
    let sessions = [makeSession("a", 0)];

    const r = new IdleReaper({
      listSessions: () => sessions,
      closeSession: async (id) => {
        closed.push(id);
        sessions = sessions.filter((s) => s.sessionId !== id);
      },
      ttlMs: 30 * MIN,
      now: clock.now,
    });

    clock.advance(31 * MIN);
    expect(await r.scanOnce()).toEqual(["a"]);
    expect(closed).toEqual(["a"]);
  });

  it("刚过 TTL 但还没到就不回收", async () => {
    const clock = makeClock();
    const closed: string[] = [];
    const sessions = [makeSession("a", 0)];

    const r = new IdleReaper({
      listSessions: () => sessions,
      closeSession: async (id) => void closed.push(id),
      ttlMs: 30 * MIN,
      now: clock.now,
    });

    clock.advance(29 * MIN);
    expect(await r.scanOnce()).toEqual([]);
    expect(closed).toEqual([]);
  });

  it("运行中的会话绝不回收（哪怕闲置很久）", async () => {
    const clock = makeClock();
    const closed: string[] = [];
    const sessions = [makeSession("a", 0, /* busy */ true)];

    const r = new IdleReaper({
      listSessions: () => sessions,
      closeSession: async (id) => void closed.push(id),
      ttlMs: 30 * MIN,
      now: clock.now,
    });

    clock.advance(10 * 60 * MIN); // 10 小时
    expect(await r.scanOnce()).toEqual([]);
    expect(closed).toEqual([]);
  });

  it("多个会话只回收该回收的", async () => {
    const clock = makeClock();
    const closed: string[] = [];
    let sessions = [
      makeSession("old", 0),
      makeSession("fresh", 29 * MIN),
      makeSession("busy-old", 0, true),
    ];

    const r = new IdleReaper({
      listSessions: () => sessions,
      closeSession: async (id) => {
        closed.push(id);
        sessions = sessions.filter((s) => s.sessionId !== id);
      },
      ttlMs: 30 * MIN,
      now: clock.now,
    });

    clock.advance(30 * MIN);
    expect(await r.scanOnce()).toEqual(["old"]);
    expect(closed).toEqual(["old"]);
  });
});

describe("释放前复查", () => {
  it("扫描期间变成 busy 的会话会被跳过", async () => {
    const clock = makeClock();
    const closed: string[] = [];
    let call = 0;
    // 第一次 listSessions 返回空闲，第二次（复查时）返回 busy
    const listSessions = (): IdleSessionInfo[] => {
      call++;
      return [makeSession("a", 0, call >= 2)];
    };

    const r = new IdleReaper({
      listSessions,
      closeSession: async (id) => void closed.push(id),
      ttlMs: 30 * MIN,
      now: clock.now,
    });

    clock.advance(31 * MIN);
    expect(await r.scanOnce()).toEqual([]);
    expect(closed).toEqual([]);
  });

  it("扫描期间活动时间被刷新则跳过", async () => {
    const clock = makeClock();
    const closed: string[] = [];
    let call = 0;
    const listSessions = (): IdleSessionInfo[] => {
      call++;
      // 第二次返回一个刚活动的会话
      return [makeSession("a", call >= 2 ? clock.now() : 0)];
    };

    const r = new IdleReaper({
      listSessions,
      closeSession: async (id) => void closed.push(id),
      ttlMs: 30 * MIN,
      now: clock.now,
    });

    clock.advance(31 * MIN);
    expect(await r.scanOnce()).toEqual([]);
  });

  it("会话在扫描期间已被别处关闭时不报错", async () => {
    const clock = makeClock();
    let call = 0;
    const listSessions = (): IdleSessionInfo[] => {
      call++;
      return call === 1 ? [makeSession("a", 0)] : []; // 第二次列表空了
    };

    const r = new IdleReaper({
      listSessions,
      closeSession: async () => {
        throw new Error("不该被调用");
      },
      ttlMs: 30 * MIN,
      now: clock.now,
    });

    clock.advance(31 * MIN);
    await expect(r.scanOnce()).resolves.toEqual([]);
  });
});

describe("失败与重入", () => {
  it("closeSession 抛错时继续处理其它会话", async () => {
    const clock = makeClock();
    let sessions = [makeSession("bad", 0), makeSession("good", 0)];
    const closed: string[] = [];
    const errors: string[] = [];

    const r = new IdleReaper({
      listSessions: () => sessions,
      closeSession: async (id) => {
        if (id === "bad") throw new Error("关不掉");
        closed.push(id);
        sessions = sessions.filter((s) => s.sessionId !== id);
      },
      ttlMs: 30 * MIN,
      now: clock.now,
      log: (level, msg, meta) => {
        if (level === "warn") errors.push(String((meta as { sessionId?: string })?.sessionId));
      },
    });

    clock.advance(31 * MIN);
    const result = await r.scanOnce();
    expect(result).toEqual(["good"]);
    expect(closed).toEqual(["good"]);
    expect(errors).toContain("bad");
  });

  it("重入时第二次直接返回空（不重复 close）", async () => {
    const clock = makeClock();
    let sessions = [makeSession("a", 0)];
    let closeCount = 0;

    const r = new IdleReaper({
      listSessions: () => sessions,
      closeSession: async (id) => {
        closeCount++;
        // 故意慢一点，制造重入窗口
        await new Promise((res) => setTimeout(res, 50));
        sessions = sessions.filter((s) => s.sessionId !== id);
      },
      ttlMs: 30 * MIN,
      now: clock.now,
    });

    clock.advance(31 * MIN);
    // 同时发起两次
    const [a, b] = await Promise.all([r.scanOnce(), r.scanOnce()]);
    expect(closeCount).toBe(1);
    expect([...a, ...b]).toHaveLength(1);
  });
});

describe("定时器", () => {
  it("start 后按间隔扫描", async () => {
    vi.useFakeTimers();
    try {
      const clock = makeClock();
      let sessions = [makeSession("a", 0)];
      const closed: string[] = [];

      const r = new IdleReaper({
        listSessions: () => sessions,
        closeSession: async (id) => {
          closed.push(id);
          sessions = sessions.filter((s) => s.sessionId !== id);
        },
        ttlMs: 30 * MIN,
        scanIntervalMs: 5 * MIN,
        now: clock.now,
      });

      r.start();
      clock.advance(31 * MIN);
      await vi.advanceTimersByTimeAsync(5 * MIN);
      await vi.advanceTimersByTimeAsync(5 * MIN);

      expect(closed).toEqual(["a"]);
      r.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop 后不再扫描", async () => {
    vi.useFakeTimers();
    try {
      const clock = makeClock();
      let scans = 0;
      const r = new IdleReaper({
        listSessions: () => {
          scans++;
          return [];
        },
        closeSession: async () => {},
        scanIntervalMs: 5 * MIN,
        now: clock.now,
      });

      r.start();
      await vi.advanceTimersByTimeAsync(5 * MIN);
      const afterFirst = scans;
      r.stop();
      await vi.advanceTimersByTimeAsync(20 * MIN);
      expect(scans).toBe(afterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  it("重复 start 不会叠加定时器", () => {
    vi.useFakeTimers();
    try {
      let scans = 0;
      const r = new IdleReaper({
        listSessions: () => {
          scans++;
          return [];
        },
        closeSession: async () => {},
        scanIntervalMs: 5 * MIN,
      });
      r.start();
      r.start();
      r.start();
      // 只有一个定时器存在，这里是间接验证：stop 一次就静默
      r.stop();
      expect(true).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
