import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  joinUrl,
  listRemoteModels,
  modelFromRemoteId,
  testConnection,
} from "../probe.js";

let server: Server | null = null;
let port = 0;
let lastHeaders: Record<string, string | string[] | undefined> = {};

async function start(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<void> {
  server = createServer((req, res) => {
    lastHeaders = req.headers;
    handler(req, res);
  });
  await new Promise<void>((r) => {
    server!.listen(0, "127.0.0.1", () => {
      port = (server!.address() as AddressInfo).port;
      r();
    });
  });
}

beforeEach(() => {
  lastHeaders = {};
  server = null;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

const base = (): string => `http://127.0.0.1:${port}/v1`;

describe("joinUrl —— 去重逻辑与 proxy 同口径", () => {
  it("base 已含路径段时不重复", () => {
    expect(joinUrl("https://h/v1", "/models")).toBe("https://h/v1/models");
    expect(joinUrl("https://h/llm/v1", "/models")).toBe("https://h/llm/v1/models");
    expect(joinUrl("https://h", "/v1/models")).toBe("https://h/v1/models");
  });

  it("base 与后缀有重叠时去重", () => {
    expect(joinUrl("https://h/v1", "/v1/models")).toBe("https://h/v1/models");
    expect(joinUrl("https://h/a/b/v1", "/v1/models")).toBe("https://h/a/b/v1/models");
  });

  it("末尾斜杠不影响", () => {
    expect(joinUrl("https://h/v1/", "/models")).toBe("https://h/v1/models");
  });
});

describe("listRemoteModels", () => {
  it("成功时返回模型 id 列表", async () => {
    await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "a" }, { id: "b" }] }));
    });
    const r = await listRemoteModels({ baseUrl: base(), apiKey: "k" });
    expect(r.ok).toBe(true);
    expect(r.models.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("带上 Bearer 认证头", async () => {
    await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "a" }] }));
    });
    await listRemoteModels({ baseUrl: base(), apiKey: "secret-key" });
    expect(lastHeaders["authorization"]).toBe("Bearer secret-key");
  });

  it("401 时返回错误而不是抛异常", async () => {
    await start((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    });
    const r = await listRemoteModels({ baseUrl: base(), apiKey: "bad" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.error).toContain("401");
  });

  it("返回成功但没有 data 时算失败", async () => {
    await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list" }));
    });
    const r = await listRemoteModels({ baseUrl: base(), apiKey: "k" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("没有模型列表");
  });

  it("连不上时返回错误，status=0", async () => {
    const r = await listRemoteModels({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
  });

  it("过滤掉没有 id 的条目", async () => {
    await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "a" }, { name: "no-id" }, { id: 123 }] }));
    });
    const r = await listRemoteModels({ baseUrl: base(), apiKey: "k" });
    expect(r.models.map((m) => m.id)).toEqual(["a"]);
  });
});

describe("testConnection", () => {
  it("成功时返回延迟与回复", async () => {
    await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "hello" } }] }),
      );
    });
    const r = await testConnection({ baseUrl: base(), apiKey: "k", model: "m1" });
    expect(r.ok).toBe(true);
    expect(r.reply).toBe("hello");
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("发的是最小请求（max_tokens=1，不流式）", async () => {
    let body = "";
    await start((req, res) => {
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [] }));
      });
    });
    await testConnection({ baseUrl: base(), apiKey: "k", model: "m1" });
    const parsed = JSON.parse(body) as { max_tokens: number; stream: boolean; model: string };
    expect(parsed.max_tokens).toBe(1);
    expect(parsed.stream).toBe(false);
    expect(parsed.model).toBe("m1");
  });

  it("上游 500 时返回错误", async () => {
    await start((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });
    const r = await testConnection({ baseUrl: base(), apiKey: "k", model: "m1" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
    expect(r.error).toContain("500");
  });

  it("错误信息里不泄漏 key", async () => {
    await start((_req, res) => {
      res.writeHead(401);
      res.end("nope");
    });
    const r = await testConnection({ baseUrl: base(), apiKey: "super-secret", model: "m1" });
    expect(JSON.stringify(r)).not.toContain("super-secret");
  });

  it("非 JSON 响应但状态 OK 也算连通", async () => {
    await start((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    const r = await testConnection({ baseUrl: base(), apiKey: "k", model: "m1" });
    expect(r.ok).toBe(true);
    expect(r.reply).toBeUndefined();
  });
});

describe("modelFromRemoteId", () => {
  it("给上游模型 id 填上可用的默认值", () => {
    const m = modelFromRemoteId("deepseek-v4-flash");
    expect(m.id).toBe("deepseek-v4-flash");
    expect(m.contextWindow).toBeGreaterThan(0);
    expect(m.maxOutput).toBeGreaterThan(0);
    expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("可以覆盖默认值", () => {
    const m = modelFromRemoteId("m", { contextWindow: 200_000, maxOutput: 16_000 });
    expect(m.contextWindow).toBe(200_000);
    expect(m.maxOutput).toBe(16_000);
  });
});
