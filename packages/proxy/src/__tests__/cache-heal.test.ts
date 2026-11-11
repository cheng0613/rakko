import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXPLICIT_TTL_MS,
  HEALABLE_FIELDS,
  LearningStore,
  OPAQUE_TTL_MS,
  decideHeal,
  routeIdentity,
  stripCacheFields,
} from "../cache-heal.js";

const WITH_CACHE = {
  model: "m",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
  prompt_cache_key: "abc123",
  prompt_cache_retention: "24h",
};

describe("decideHeal：什么时候该试", () => {
  it("400 + 明确提到缓存字段 → explicit 重试", () => {
    const d = decideHeal(WITH_CACHE, 400, '{"error":"Unknown parameter: prompt_cache_key"}');
    expect(d.retry).toBe(true);
    expect(d.kind).toBe("explicit");
    expect(d.strip).toEqual(["prompt_cache_key", "prompt_cache_retention"]);
  });

  it("400 + 原因不明 → opaque 重试一次", () => {
    const d = decideHeal(WITH_CACHE, 400, '{"error":"Bad Request"}');
    expect(d.retry).toBe(true);
    expect(d.kind).toBe("opaque");
  });

  it("只移除实际存在的字段", () => {
    const only = { model: "m", prompt_cache_key: "abc" };
    // 响应点名了 prompt_cache_key → explicit
    const d = decideHeal(only, 400, "Unknown parameter: prompt_cache_key");
    expect(d.strip).toEqual(["prompt_cache_key"]);
  });

  it("原因不明的 400 也会带出实际存在的字段", () => {
    const only = { model: "m", prompt_cache_key: "abc" };
    const d = decideHeal(only, 400, '{"error":"Bad Request"}');
    expect(d.retry).toBe(true);
    expect(d.strip).toEqual(["prompt_cache_key"]);
  });

  it("请求里没有缓存字段 → 不试", () => {
    const d = decideHeal({ model: "m", messages: [] }, 400, "anything");
    expect(d.retry).toBe(false);
  });

  it("状态码不是 400 → 不试", () => {
    for (const code of [401, 403, 429, 500, 502, 503]) {
      expect(decideHeal(WITH_CACHE, code, "whatever").retry).toBe(false);
    }
  });
});

describe("decideHeal：明确不该试的错误", () => {
  it.each([
    ["Unauthorized", '{"error":"Unauthorized"}'],
    ["鉴权", '{"error":"Invalid API key provided"}'],
    ["限流", '{"error":"Rate limit exceeded"}'],
    ["配额", '{"error":"Insufficient quota"}'],
    ["上下文过长", '{"error":"maximum context length is 128000 tokens"}'],
    ["模型不存在", '{"error":"The model does not exist"}'],
    ["缺必填", '{"error":"messages is required"}'],
    ["类型错", '{"error":"invalid type for messages"}'],
    ["不支持参数", '{"error":"unsupported parameter: temperature"}'],
  ])("%s → 不重试", (_label, body) => {
    const d = decideHeal(WITH_CACHE, 400, body);
    expect(d.retry).toBe(false);
    expect(d.strip).toEqual([]);
  });

  it("明确点名缓存字段优先于其它特征", () => {
    // 同时含 "unsupported parameter" 和 "prompt_cache_key" → 该试
    const d = decideHeal(
      WITH_CACHE,
      400,
      '{"error":"unsupported parameter: prompt_cache_key"}',
    );
    expect(d.retry).toBe(true);
    expect(d.kind).toBe("explicit");
  });
});

describe("stripCacheFields", () => {
  it("移除两个字段，保留其它", () => {
    const out = stripCacheFields(WITH_CACHE);
    expect(out).not.toHaveProperty("prompt_cache_key");
    expect(out).not.toHaveProperty("prompt_cache_retention");
    expect(out.model).toBe("m");
    expect(out.stream).toBe(true);
  });

  it("不改原对象", () => {
    const before = JSON.stringify(WITH_CACHE);
    stripCacheFields(WITH_CACHE);
    expect(JSON.stringify(WITH_CACHE)).toBe(before);
  });

  it("只允许这两个字段，不误删别的", () => {
    const body = { model: "m", max_completion_tokens: 100, store: false };
    const out = stripCacheFields(body);
    expect(out).toEqual(body);
  });

  it("HEALABLE_FIELDS 只有两个", () => {
    expect(HEALABLE_FIELDS).toHaveLength(2);
  });
});

describe("routeIdentity", () => {
  it("同协议同端点 → 同身份", () => {
    expect(routeIdentity("openai", "https://a.com/v1")).toBe(
      routeIdentity("openai", "https://a.com/v1"),
    );
  });

  it("端点不同 → 身份不同", () => {
    expect(routeIdentity("openai", "https://a.com/v1")).not.toBe(
      routeIdentity("openai", "https://a.com/v2"),
    );
  });

  it("协议不同 → 身份不同", () => {
    expect(routeIdentity("openai", "https://a.com/v1")).not.toBe(
      routeIdentity("anthropic", "https://a.com/v1"),
    );
  });

  it("查询参数不同 → 身份不同", () => {
    expect(routeIdentity("openai", "https://a.com/v1?x=1")).not.toBe(
      routeIdentity("openai", "https://a.com/v1?x=2"),
    );
  });

  it("不暴露原始 URL", () => {
    const id = routeIdentity("openai", "https://secret-host.com/v1?key=abc");
    expect(id).not.toContain("secret-host");
    expect(id).not.toContain("abc");
    expect(id).toMatch(/^[a-f0-9]{32}$/);
  });
});

describe("LearningStore", () => {
  let dir: string;
  let file: string;
  let store: LearningStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "rakko-heal-"));
    file = path.join(dir, "overrides.json");
    store = new LearningStore(file);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("学完后能查到", async () => {
    await store.learn({ route: "r1", strip: ["prompt_cache_key"], kind: "explicit" });
    const hit = await store.lookup("r1");
    expect(hit?.kind).toBe("explicit");
    expect(hit?.strip).toEqual(["prompt_cache_key"]);
  });

  it("没学过的线路返回 null", async () => {
    expect(await store.lookup("r-unknown")).toBeNull();
  });

  it("explicit 记录 7 天后过期", async () => {
    const t0 = 1_000_000;
    await store.learn({ route: "r1", strip: ["prompt_cache_key"], kind: "explicit", now: t0 });

    expect(await store.lookup("r1", t0 + EXPLICIT_TTL_MS - 1000)).not.toBeNull();
    expect(await store.lookup("r1", t0 + EXPLICIT_TTL_MS + 1000)).toBeNull();
  });

  it("opaque 记录 24 小时后过期", async () => {
    const t0 = 1_000_000;
    await store.learn({ route: "r1", strip: ["prompt_cache_key"], kind: "opaque", now: t0 });

    expect(await store.lookup("r1", t0 + OPAQUE_TTL_MS - 1000)).not.toBeNull();
    expect(await store.lookup("r1", t0 + OPAQUE_TTL_MS + 1000)).toBeNull();
  });

  it("同线路再学一次会覆盖", async () => {
    await store.learn({ route: "r1", strip: ["prompt_cache_key"], kind: "opaque" });
    await store.learn({ route: "r1", strip: ["prompt_cache_key"], kind: "explicit" });
    const hit = await store.lookup("r1");
    expect(hit?.kind).toBe("explicit");
  });

  it("flush 后可被新实例读到", async () => {
    await store.learn({ route: "r1", strip: ["prompt_cache_key"], kind: "explicit" });
    await store.flush();
    const fresh = new LearningStore(file);
    expect(await fresh.lookup("r1")).not.toBeNull();
  });

  it("坏文件当作没学过，不抛错", async () => {
    await fs.writeFile(file, "{not json", "utf8");
    const fresh = new LearningStore(file);
    expect(await fresh.lookup("r1")).toBeNull();
  });

  it("version 不对也当作没学过", async () => {
    await fs.writeFile(file, JSON.stringify({ version: 2, routes: [] }), "utf8");
    const fresh = new LearningStore(file);
    expect(await fresh.lookup("r1")).toBeNull();
  });

  it("clear 后全部失效", async () => {
    await store.learn({ route: "r1", strip: ["prompt_cache_key"], kind: "explicit" });
    await store.clear();
    expect(await store.lookup("r1")).toBeNull();
  });

  it("文件里不出现原始 endpoint（只有哈希）", async () => {
    await store.learn({
      route: routeIdentity("openai", "https://secret.com/v1?key=xyz"),
      strip: ["prompt_cache_key"],
      kind: "explicit",
    });
    await store.flush();
    const raw = await fs.readFile(file, "utf8");
    expect(raw).not.toContain("secret.com");
    expect(raw).not.toContain("xyz");
  });
});
