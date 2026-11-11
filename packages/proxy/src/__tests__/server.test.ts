import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildUpstreamUrl, createCompatProxy, isPlaceholderKey, type ProxyHandle } from "../server.js";

let upstream: Server | null = null;
let upstreamPort = 0;
let proxy: ProxyHandle | null = null;

/** 起一个假上游，记录收到的请求 */
interface Captured {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
let captured: Captured | null = null;

async function startUpstream(
  handler?: (res: import("node:http").ServerResponse) => void,
): Promise<void> {
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured = { url: req.url ?? "", headers: req.headers, body };
      if (handler) {
        handler(res);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise<void>((resolve) => {
    upstream!.listen(0, "127.0.0.1", () => {
      upstreamPort = (upstream!.address() as AddressInfo).port;
      resolve();
    });
  });
}

beforeEach(async () => {
  captured = null;
  proxy = null;
  await startUpstream();
});

afterEach(async () => {
  await proxy?.dispose();
  proxy = null;
  if (upstream) {
    await new Promise<void>((r) => upstream!.close(() => r()));
    upstream = null;
  }
});

function sessionFromHeader(req: import("node:http").IncomingMessage): string | null {
  const v = req.headers["x-rakko-session"];
  return typeof v === "string" ? v : null;
}

describe("key 替换 —— 这是 proxy 存在的理由", () => {
  it("占位 key 被替换成真 key 后才发往上游", async () => {
    proxy = await createCompatProxy({ resolveSession: sessionFromHeader });
    proxy.register("s1", { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: "REAL-KEY-ABC" });

    await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "x-rakko-session": "s1",
        authorization: "Bearer proxy-managed-aaaaaaaa",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "m", messages: [] }),
    });

    expect(captured?.headers["authorization"]).toBe("Bearer REAL-KEY-ABC");
  });

  it("上游永远看不到占位值", async () => {
    proxy = await createCompatProxy({ resolveSession: sessionFromHeader });
    proxy.register("s1", { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: "REAL" });

    await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-rakko-session": "s1", authorization: "Bearer proxy-managed-zzz" },
      body: "{}",
    });

    expect(captured?.headers["authorization"]).not.toContain("proxy-managed");
  });

  it("两个会话各自用自己的 key", async () => {
    proxy = await createCompatProxy({ resolveSession: sessionFromHeader });
    proxy.register("a", { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: "KEY-A" });
    proxy.register("b", { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: "KEY-B" });

    await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-rakko-session": "a" },
      body: "{}",
    });
    expect(captured?.headers["authorization"]).toBe("Bearer KEY-A");

    await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-rakko-session": "b" },
      body: "{}",
    });
    expect(captured?.headers["authorization"]).toBe("Bearer KEY-B");
  });

  it("未注册的会话返回 404，不会打到上游", async () => {
    proxy = await createCompatProxy({ resolveSession: sessionFromHeader });
    const res = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-rakko-session": "unknown" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    expect(captured).toBeNull();
  });

  it("缺少会话标识返回 400", async () => {
    proxy = await createCompatProxy({ resolveSession: sessionFromHeader });
    const res = await fetch(`${proxy.url}/v1/chat/completions`, { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
    expect(captured).toBeNull();
  });
});

describe("请求体与头部透传", () => {
  it("请求体原样转发，不被改写", async () => {
    proxy = await createCompatProxy({ resolveSession: sessionFromHeader });
    proxy.register("s1", { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: "K" });

    const body = JSON.stringify({
      model: "m",
      messages: [{ role: "user", content: "你好" }],
      stream: true,
      prompt_cache_key: "abc",
      store: false,
      max_completion_tokens: 100,
    });

    await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-rakko-session": "s1", "content-type": "application/json" },
      body,
    });

    expect(captured?.body).toBe(body);
    const parsed = JSON.parse(captured!.body) as Record<string, unknown>;
    expect(parsed["prompt_cache_key"]).toBe("abc");
    expect(parsed["max_completion_tokens"]).toBe(100);
  });

  it("路径与查询参数被保留", async () => {
    proxy = await createCompatProxy({ resolveSession: sessionFromHeader });
    proxy.register("s1", { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: "K" });

    await fetch(`${proxy.url}/v1/chat/completions?foo=bar`, {
      method: "POST",
      headers: { "x-rakko-session": "s1" },
      body: "{}",
    });

    expect(captured?.url).toBe("/v1/chat/completions?foo=bar");
  });

  it("host 头被改成上游的，不能透传 loopback 的 host", async () => {
    proxy = await createCompatProxy({ resolveSession: sessionFromHeader });
    proxy.register("s1", { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: "K" });

    await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-rakko-session": "s1" },
      body: "{}",
    });

    expect(captured?.headers["host"]).toContain(`127.0.0.1:${upstreamPort}`);
  });
});

describe("不变量 12：响应字节级 pipe，禁止缓冲", () => {
  it("SSE 分片到达时客户端立刻能收到，不是等全部生成完", async () => {
    let releaseSecond: (() => void) | null = null;
    const secondReady = new Promise<void>((r) => {
      releaseSecond = r;
    });

    await new Promise<void>((r) => upstream!.close(() => r()));
    await startUpstream((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // 先发一片
      res.write('data: {"choices":[{"delta":{"content":"第一片"}}]}\n\n');
      // 留一个可观察的间隙，证明客户端在这期间已经收到
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":"第二片"}}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
        releaseSecond?.();
      }, 350);
    });

    proxy = await createCompatProxy({ resolveSession: sessionFromHeader });
    proxy.register("s1", { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: "K" });

    const res = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-rakko-session": "s1" },
      body: "{}",
    });
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const first = await reader.read();
    const firstText = new TextDecoder().decode(first.value);
    expect(firstText).toContain("第一片");
    // 关键在于：这条断言在第一片到达时就成立，不需要等第二片
    expect(firstText).not.toContain("第二片");

    await secondReady;
    reader.cancel().catch(() => {});
  });
});

describe("用量观察", () => {
  it("从 SSE 里抓到 usage 并回调", async () => {
    await new Promise<void>((r) => upstream!.close(() => r()));
    await startUpstream((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
      res.write(
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7,"cache_read_input_tokens":3}}\n\n',
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const seen: Array<{ sessionId: string; input: number; output: number; cacheRead: number }> = [];
    proxy = await createCompatProxy({
      resolveSession: sessionFromHeader,
      observers: {
        onUsage: (sessionId, usage) =>
          seen.push({
            sessionId,
            input: usage.inputTokens,
            output: usage.outputTokens,
            cacheRead: usage.cacheReadTokens,
          }),
      },
    });
    proxy.register("s1", { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: "K" });

    const res = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-rakko-session": "s1" },
      body: "{}",
    });
    await res.text();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toEqual({ sessionId: "s1", input: 12, output: 7, cacheRead: 3 });
  });
});

describe("上游错误", () => {
  it("上游 500 时透传状态码，并回调 onUpstreamError", async () => {
    await new Promise<void>((r) => upstream!.close(() => r()));
    await startUpstream((res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "boom" } }));
    });

    const errors: Array<{ status: number }> = [];
    proxy = await createCompatProxy({
      resolveSession: sessionFromHeader,
      observers: { onUpstreamError: (_s, status) => errors.push({ status }) },
    });
    proxy.register("s1", { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: "K" });

    const res = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-rakko-session": "s1" },
      body: "{}",
    });
    expect(res.status).toBe(500);
    await res.text();
    expect(errors[0]).toEqual({ status: 500 });
  });

  it("上游连不上时返回 502，不把占位 key 暴露给客户端", async () => {
    proxy = await createCompatProxy({ resolveSession: sessionFromHeader });
    // 指向一个肯定没有服务的端口
    proxy.register("s1", { baseUrl: "http://127.0.0.1:1/v1", apiKey: "SECRET" });

    const res = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "x-rakko-session": "s1" },
      body: "{}",
    });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("SECRET");
  });
});

describe("工具函数", () => {
  it("isPlaceholderKey 只认我们的前缀", () => {
    expect(isPlaceholderKey("proxy-managed-abc")).toBe(true);
    expect(isPlaceholderKey("sk-real")).toBe(false);
    expect(isPlaceholderKey(undefined)).toBe(false);
    expect(isPlaceholderKey("")).toBe(false);
  });

  it("buildUpstreamUrl 不会拼出 /v1/v1", () => {
    expect(buildUpstreamUrl("https://api.openai.com/v1", "/v1/chat/completions")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(buildUpstreamUrl("https://api.openai.com/v1/", "/v1/chat/completions")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(buildUpstreamUrl("https://host/v1", "/chat/completions")).toBe(
      "https://host/v1/chat/completions",
    );
    expect(buildUpstreamUrl("https://host", "/v1/chat/completions")).toBe(
      "https://host/v1/chat/completions",
    );
  });

  it("base 更深时也只保留一层 v1（真实上游踩到的）", () => {
    // 实测上游：https://d-openai.juneyaoair.com/llm/v1
    // pi 发：/v1/chat/completions
    // 早期实现拼成 /llm/v1/v1/chat/completions，上游 404
    expect(
      buildUpstreamUrl("https://d-openai.juneyaoair.com/llm/v1", "/v1/chat/completions"),
    ).toBe("https://d-openai.juneyaoair.com/llm/v1/chat/completions");
  });

  it("base 与请求路径完全重叠时不多拼", () => {
    expect(buildUpstreamUrl("https://host/v1/chat", "/v1/chat")).toBe("https://host/v1/chat");
  });

  it("多段重叠只去一次", () => {
    expect(buildUpstreamUrl("https://host/a/b/v1", "/v1/chat/completions")).toBe(
      "https://host/a/b/v1/chat/completions",
    );
  });

  it("buildUpstreamUrl 保留查询参数", () => {
    expect(buildUpstreamUrl("http://h/v1", "/v1/chat/completions?a=1")).toBe(
      "http://h/v1/chat/completions?a=1",
    );
  });
});
