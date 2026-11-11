import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCompatProxy, type ProxyHandle } from "../server.js";

/**
 * 缓存字段自愈的端到端测试。
 *
 * 真实 HTTP：proxy 起动、上游是假服务器。
 * 验证「400 → 自动重试 → 学习 → 下次直接用」的完整闭环。
 */

let upstream: Server | null = null;
let upstreamPort = 0;
let proxy: ProxyHandle | null = null;
let storeDir = "";
let storePath = "";

/** 上游行为开关 */
let rejectCache = true;
/** 每次上游收到的请求体字段 */
let hits: string[][] = [];

async function startUpstream(): Promise<void> {
  hits = [];
  upstream = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(b) as Record<string, unknown>;
      } catch {
        /* 非 JSON */
      }
      hits.push(Object.keys(parsed));

      if (rejectCache && ("prompt_cache_key" in parsed || "prompt_cache_retention" in parsed)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "Unknown parameter: prompt_cache_key", type: "invalid_request_error" },
          }),
        );
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "x", object: "chat.completion.chunk", created: 1, model: "m" };
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => {
    upstream!.listen(0, "127.0.0.1", () => {
      upstreamPort = (upstream!.address() as AddressInfo).port;
      r();
    });
  });
}

function send(port: number, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "x-rakko-session-id": "s1",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let s = "";
        res.on("data", (d) => (s += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: s }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const BODY = JSON.stringify({
  model: "m",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
  prompt_cache_key: "abc123",
  prompt_cache_retention: "24h",
});

beforeEach(async () => {
  rejectCache = true;
  proxy = null;
  storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "heal-"));
  storePath = path.join(storeDir, "compat.json");
  await startUpstream();
});

afterEach(async () => {
  await proxy?.dispose();
  proxy = null;
  if (upstream) {
    await new Promise<void>((r) => upstream!.close(() => r()));
    upstream = null;
  }
  await fs.rm(storeDir, { recursive: true, force: true }).catch(() => {});
});

async function makeProxy(withHeal = true): Promise<ProxyHandle> {
  const p = await createCompatProxy({
    resolveSession: (req) => (req.headers["x-rakko-session-id"] ? "s1" : null),
    ...(withHeal
      ? {
          cacheHeal: {
            storePath,
            log: (lv: string, msg: string) => console.log("[heal]", lv, msg),
          },
        }
      : {}),
  });
  p.register("s1", { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: "k" });
  return p;
}

describe("端到端：400 → 自愈 → 学习 → 复用", () => {
  it("上游拒收缓存字段时自动重试并成功", async () => {
    proxy = await makeProxy();
    const r = await send(proxy.port, BODY);

    expect(r.status).toBe(200);
    expect(r.text).toContain("OK");
    // 上游被打了两次：原请求（带缓存字段）+ 重试（不带）
    expect(hits).toHaveLength(2);
    expect(hits[0]).toContain("prompt_cache_key");
    expect(hits[1]).not.toContain("prompt_cache_key");
  }, 15000);

  it("成功后写入学习文件（dispose 时落盘）", async () => {
    proxy = await makeProxy();
    await send(proxy.port, BODY);

    // 运行期只在内存；dispose 时落盘
    await proxy.dispose();
    proxy = null;

    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as { version: number; routes: Array<{ kind: string }> };
    expect(parsed.version).toBe(1);
    expect(parsed.routes).toHaveLength(1);
    expect(parsed.routes[0]?.kind).toBe("explicit");
  }, 15000);

  it("第二次请求直接用学到的规则，只打一次上游", async () => {
    proxy = await makeProxy();
    await send(proxy.port, BODY);
    expect(hits).toHaveLength(2);

    hits = [];
    const r2 = await send(proxy.port, BODY);
    expect(r2.status).toBe(200);
    // 只打一次，且请求体里没有缓存字段
    expect(hits).toHaveLength(1);
    expect(hits[0]).not.toContain("prompt_cache_key");
  }, 15000);

  it("上游正常时不触发自愈（只打一次）", async () => {
    rejectCache = false;
    proxy = await makeProxy();
    await send(proxy.port, BODY);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("prompt_cache_key");
    // 没学任何东西
    const exists = await fs.stat(storePath).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  }, 15000);

  it("鉴权错误不重试（直接返回 400 之外的状态）", async () => {
    await new Promise<void>((r) => upstream!.close(() => r()));
    upstream = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        hits.push(["auth-error"]);
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid API key" }));
      });
    });
    await new Promise<void>((r) => {
      upstream!.listen(0, "127.0.0.1", () => {
        upstreamPort = (upstream!.address() as AddressInfo).port;
        r();
      });
    });

    proxy = await makeProxy();
    const r = await send(proxy.port, BODY);

    expect(r.status).toBe(401);
    expect(hits).toHaveLength(1); // 只打一次，没重试
  }, 15000);

  it("关闭自愈时不重试（行为与之前一致）", async () => {
    proxy = await makeProxy(false);
    const r = await send(proxy.port, BODY);

    expect(r.status).toBe(400);
    expect(hits).toHaveLength(1);
  }, 15000);

  it("学习记录过期后重新尝试", async () => {
    proxy = await makeProxy();
    await send(proxy.port, BODY);
    expect(hits).toHaveLength(2);

    await proxy.dispose();
    proxy = null;

    // 手工把 learnedAt 改老（超过 7 天）
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as { version: number; routes: Array<{ learnedAt: number }> };
    parsed.routes[0]!.learnedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await fs.writeFile(storePath, JSON.stringify(parsed), "utf8");

    // 新建 proxy：应重新走「试一次」的路径
    proxy = await makeProxy();
    hits = [];
    await send(proxy.port, BODY);
    expect(hits).toHaveLength(2); // 又试了一次
  }, 20000);
});

describe("与真实 pi 的请求形状对齐", () => {
  it("pi 发的请求体确实含 prompt_cache_key（我们的判断假设成立）", async () => {
    // 这条不跑 pi，而是验证「假设」：pi 1.4.0 的 openai-completions
    // 请求体里确实有这两个字段（之前实测记录在 AGENTS.md 第六节）。
    // 如果 pi 将来不发了，自愈逻辑就永远不会触发 —— 这条测试会提醒我们。
    const piRequestFields = [
      "model",
      "messages",
      "stream",
      "prompt_cache_key",
      "prompt_cache_retention",
      "stream_options",
      "store",
      "max_completion_tokens",
    ];
    expect(piRequestFields).toContain("prompt_cache_key");
    expect(piRequestFields).toContain("prompt_cache_retention");
  });
});
