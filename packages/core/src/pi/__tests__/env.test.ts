import { describe, expect, it } from "vitest";
import { PLACEHOLDER_KEY_PREFIX, buildPiEnv, derivePlaceholderKey, hashPiEnv } from "../env.js";

const BASE = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  DATABASE_URL: "postgres://should-not-leak",
  SECRET_TOKEN: "should-not-leak",
};

const OPTS = {
  sessionId: "sess-1234-abcd",
  agentHome: "/tmp/agenthome",
  proxyPort: 52847,
  baseEnv: BASE,
};

describe("不变量 2：spawn env 逐字节稳定", () => {
  it("同一 sessionId 两次构造，结果完全相同", () => {
    const a = buildPiEnv(OPTS);
    const b = buildPiEnv(OPTS);
    expect(a).toEqual(b);
    expect(hashPiEnv(a)).toBe(hashPiEnv(b));
  });

  it("连续构造 100 次，指纹始终一致（没有任何随机量）", () => {
    const first = hashPiEnv(buildPiEnv(OPTS));
    for (let i = 0; i < 100; i++) {
      expect(hashPiEnv(buildPiEnv(OPTS))).toBe(first);
    }
  });

  it("不同 sessionId 得到不同占位 key", () => {
    const a = derivePlaceholderKey("sess-aaaa");
    const b = derivePlaceholderKey("sess-bbbb");
    expect(a).not.toBe(b);
  });

  it("占位 key 是纯函数", () => {
    const a = derivePlaceholderKey("sess-1234");
    const b = derivePlaceholderKey("sess-1234");
    expect(a).toBe(b);
  });
});

describe("key 不进 env（不变量 13）", () => {
  it("env 里的 key 是占位值，不是真 key", () => {
    const env = buildPiEnv(OPTS);
    expect(env["RAKKO_PI_API_KEY"]).toMatch(new RegExp(`^${PLACEHOLDER_KEY_PREFIX}`));
  });

  it("env 里不会有任何 sk- 开头的真 key", () => {
    const env = buildPiEnv(OPTS);
    const all = Object.values(env).join("\n");
    expect(all).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
  });

  it("不把整个 process.env 透传进去", () => {
    const env = buildPiEnv(OPTS);
    expect(env["DATABASE_URL"]).toBeUndefined();
    expect(env["SECRET_TOKEN"]).toBeUndefined();
  });
});

describe("必需的 env 键", () => {
  it("包含 pi 运行时需要的全部键", () => {
    const env = buildPiEnv(OPTS);
    expect(env["PI_CODING_AGENT_DIR"]).toBeTruthy();
    expect(env["RAKKO_PI_SESSION_ID"]).toBe("sess-1234-abcd");
    expect(env["RAKKO_PI_PROXY_PORT"]).toBe("52847");
    expect(env["RAKKO_PI_API_KEY"]).toBeTruthy();
  });

  it("设置 NO_PROXY 防止全局代理劫走 loopback", () => {
    const env = buildPiEnv(OPTS);
    expect(env["NO_PROXY"]).toContain("127.0.0.1");
    expect(env["NO_PROXY"]).toContain("localhost");
    expect(env["no_proxy"]).toContain("127.0.0.1");
  });

  it("PI_OFFLINE=1 关掉启动期联网", () => {
    expect(buildPiEnv(OPTS)["PI_OFFLINE"]).toBe("1");
  });

  it("agentHome 被解析成绝对路径", () => {
    const env = buildPiEnv(OPTS);
    expect(env["PI_CODING_AGENT_DIR"]).toBeTruthy();
    // 路径分隔符可能是 Windows 的
    expect(env["PI_CODING_AGENT_DIR"]).toMatch(/agenthome/);
  });
});

describe("extra env 合并", () => {
  it("extra 覆盖默认值", () => {
    const env = buildPiEnv({ ...OPTS, extra: { RAKKO_PI_PROXY_PORT: "9999" } });
    expect(env["RAKKO_PI_PROXY_PORT"]).toBe("9999");
  });

  it("extra 引入新键后仍然稳定", () => {
    const withExtra = (): string =>
      hashPiEnv(buildPiEnv({ ...OPTS, extra: { FOO: "bar" } }));
    expect(withExtra()).toBe(withExtra());
  });
});

describe("hashPiEnv", () => {
  it("键顺序不影响指纹", () => {
    const a = hashPiEnv({ A: "1", B: "2" });
    const b = hashPiEnv({ B: "2", A: "1" });
    expect(a).toBe(b);
  });

  it("值不同则指纹不同", () => {
    expect(hashPiEnv({ A: "1" })).not.toBe(hashPiEnv({ A: "2" }));
  });
});
