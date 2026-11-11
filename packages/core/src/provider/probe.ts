/**
 * 运营商连通性探测。
 *
 * 两件事：
 *   1. `GET /v1/models` 拉模型列表（很多兼容端点都支持）
 *   2. 发一条最小对话，确认真的能用
 *
 * 都由主进程发起，key 不经过渲染进程。
 */
import http from "node:http";
import https from "node:https";
import type { ModelCost } from "@rakko/shared";

export interface ProbeOptions {
  baseUrl: string;
  apiKey: string;
  /** 单次请求超时，默认 20s */
  timeoutMs?: number;
}

export interface RemoteModel {
  id: string;
}

export interface ListModelsResult {
  ok: boolean;
  /** 成功时的模型 id 列表 */
  models: RemoteModel[];
  /** 失败原因（可直接展示给用户） */
  error?: string;
  /** HTTP 状态码，网络层失败时为 0 */
  status: number;
}

export interface TestConnectionResult {
  ok: boolean;
  /** 首轮往返耗时 */
  latencyMs: number;
  status: number;
  /** 成功时模型的实际回复（截断） */
  reply?: string;
  error?: string;
}

const DEFAULT_TIMEOUT = 20_000;

/**
 * 把 baseUrl 与路径拼起来，去掉重复段。
 *
 * 与 CompatProxy 的 buildUpstreamUrl 同一算法 —— 上游形状千奇百怪
 * （`/v1`、`/llm/v1`、根路径），必须按最长重叠去重。
 */
export function joinUrl(baseUrl: string, pathSuffix: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = pathSuffix.startsWith("/") ? pathSuffix : `/${pathSuffix}`;

  const u = new URL(base);
  const baseSeg = u.pathname.split("/").filter(Boolean);
  const reqSeg = suffix.split("?")[0]!.split("/").filter(Boolean);

  let overlap = 0;
  const max = Math.min(baseSeg.length, reqSeg.length);
  for (let len = max; len > 0; len--) {
    if (baseSeg.slice(-len).join("/") === reqSeg.slice(0, len).join("/")) {
      overlap = len;
      break;
    }
  }
  return `${u.origin}/${[...baseSeg, ...reqSeg.slice(overlap)].join("/")}`;
}

interface RawResponse {
  status: number;
  body: string;
}

function request(
  method: "GET" | "POST",
  url: string,
  apiKey: string,
  body?: unknown,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const transport = isHttps ? https : http;

    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
    };
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    }

    const req = transport.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );

    req.on("error", (e) => reject(e));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`请求超时（${timeoutMs}ms）`));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/** 从上游拉模型列表 */
export async function listRemoteModels(options: ProbeOptions): Promise<ListModelsResult> {
  const url = joinUrl(options.baseUrl, "/models");
  try {
    const res = await request("GET", url, options.apiKey, undefined, options.timeoutMs);
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        models: [],
        status: res.status,
        error: `上游返回 ${res.status}：${res.body.slice(0, 300)}`,
      };
    }
    const parsed = JSON.parse(res.body) as { data?: Array<{ id?: unknown }> };
    const models = (parsed.data ?? [])
      .map((m) => (typeof m.id === "string" ? { id: m.id } : null))
      .filter((m): m is RemoteModel => m !== null);

    if (models.length === 0) {
      return {
        ok: false,
        models: [],
        status: res.status,
        error: "上游返回成功但没有模型列表（可能不支持 /models）",
      };
    }
    return { ok: true, models, status: res.status };
  } catch (e) {
    return { ok: false, models: [], status: 0, error: (e as Error).message };
  }
}

/**
 * 发一条最小对话，确认这个 provider + key + model 真的能用。
 *
 * 用 1 token 的请求，尽量少花钱。
 */
export async function testConnection(
  options: ProbeOptions & { model: string },
): Promise<TestConnectionResult> {
  const url = joinUrl(options.baseUrl, "/chat/completions");
  const started = Date.now();
  try {
    const res = await request(
      "POST",
      url,
      options.apiKey,
      {
        model: options.model,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        stream: false,
      },
      options.timeoutMs,
    );
    const latencyMs = Date.now() - started;

    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        latencyMs,
        status: res.status,
        error: `上游返回 ${res.status}：${res.body.slice(0, 300)}`,
      };
    }

    let reply: string | undefined;
    try {
      const parsed = JSON.parse(res.body) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = parsed.choices?.[0]?.message?.content;
      if (typeof content === "string") reply = content.slice(0, 100);
    } catch {
      /* 有些端点不返回标准 JSON，状态码 OK 就够 */
    }

    return { ok: true, latencyMs, status: res.status, ...(reply ? { reply } : {}) };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, status: 0, error: (e as Error).message };
  }
}

/**
 * 把上游模型 id 转成我们的 ModelDescriptor。
 *
 * 上游只给 id，不给上下文长度与价格，所以要填默认值。
 * 用户可以在设置页改 —— 这里给的是能跑起来的保守值。
 */
export function modelFromRemoteId(
  id: string,
  overrides: { contextWindow?: number; maxOutput?: number; cost?: ModelCost } = {},
): {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  capabilities: { supportsTools: boolean; supportsImage: boolean; supportsThinking: boolean };
  cost: ModelCost;
} {
  return {
    id,
    name: id,
    contextWindow: overrides.contextWindow ?? 128_000,
    maxOutput: overrides.maxOutput ?? 8_192,
    capabilities: { supportsTools: true, supportsImage: false, supportsThinking: false },
    cost: overrides.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}
