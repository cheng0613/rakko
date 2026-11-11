/**
 * CompatProxy：本地 loopback 代理。
 *
 * 存在的唯一理由：**让真 key 不进入 pi 子进程的 env。**
 *
 * 工作方式：
 *   pi 的 models.json 里 baseUrl 指向本代理，apiKey 是 $RAKKO_PI_API_KEY（占位值）
 *   → pi 把占位值放进 Authorization 头
 *   → 代理按 sessionId 从内存里取出真 key，替换掉 Authorization
 *   → 转发真实请求到上游
 *
 * 硬约束（AGENTS.md 不变量 12）：**响应必须字节级 pipe，禁止缓冲**。
 * 缓冲会让 SSE 流式退化成「等全部生成完再一次性吐出」，体验直接崩掉。
 *
 * 边界说明（诚实）：
 *   loopback 不是安全边界。同机其它进程可以向这个端口发请求。
 *   我们做的是「让 pi 拿不到 key」，不是「防止本机恶意进程」。
 *   真正的隔离需要 OS 级手段，本项目不做。
 */
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** 上游目标。由调用方注册，代理只负责转发。 */
export interface UpstreamTarget {
  /** 真实上游 baseUrl，如 https://api.openai.com/v1 */
  baseUrl: string;
  /** 真实 key */
  apiKey: string;
}

export interface TokenUsageDelta {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ProxyObservers {
  /** 观察到的用量（来自 SSE 的 usage 字段） */
  onUsage?: (sessionId: string, usage: TokenUsageDelta) => void;
  /** 请求失败 */
  onUpstreamError?: (sessionId: string, status: number, detail: string) => void;
  /** 日志 */
  log?: (level: "info" | "warn" | "error", msg: string, meta?: unknown) => void;
}

export interface ProxyHandle {
  /** 监听端口 */
  port: number;
  /** 代理根地址，如 http://127.0.0.1:52847 */
  url: string;
  /** 注册一个会话的上游与 key */
  register(sessionId: string, target: UpstreamTarget): void;
  /** 注销 */
  unregister(sessionId: string): void;
  /** 关闭 */
  dispose(): Promise<void>;
}

export interface CreateProxyOptions {
  /** 让代理能从请求里认出是哪个会话 */
  resolveSession: (req: IncomingMessage) => string | null;
  /** 监听端口，0 表示随机 */
  port?: number;
  observers?: ProxyObservers;
}

/** 占位 key 前缀，与 env.ts 保持一致 */
const PLACEHOLDER_PREFIX = "proxy-managed-";

export function isPlaceholderKey(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith(PLACEHOLDER_PREFIX);
}

/**
 * 从 Authorization 头取出 key。
 */
function readBearer(headers: http.IncomingHttpHeaders): string | null {
  const raw = headers["authorization"];
  if (typeof raw !== "string") return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}

/**
 * 按行解析 SSE，抓 usage。不改变数据流，只旁路观察。
 */
function observeUsage(
  chunk: Buffer,
  sessionId: string,
  onUsage: (sessionId: string, usage: TokenUsageDelta) => void,
  seen: { done: boolean },
): void {
  if (seen.done) return;
  const text = chunk.toString("utf8");
  if (!text.includes("usage")) return;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") {
      seen.done = true;
      return;
    }
    try {
      const json = JSON.parse(payload) as { usage?: Record<string, unknown> };
      const u = json.usage;
      if (!u) continue;
      const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      const delta: TokenUsageDelta = {
        inputTokens: num(u["prompt_tokens"] ?? u["input_tokens"]),
        outputTokens: num(u["completion_tokens"] ?? u["output_tokens"]),
        cacheReadTokens: num(u["cache_read_input_tokens"] ?? u["cacheRead"]),
        cacheWriteTokens: num(u["cache_creation_input_tokens"] ?? u["cacheWrite"]),
      };
      if (delta.inputTokens + delta.outputTokens > 0) {
        onUsage(sessionId, delta);
      }
    } catch {
      /* 非 JSON 的 data 行，忽略 */
    }
  }
}

export async function createCompatProxy(options: CreateProxyOptions): Promise<ProxyHandle> {
  const registry = new Map<string, UpstreamTarget>();
  const log = options.observers?.log ?? (() => {});
  const onUsage = options.observers?.onUsage;
  const onUpstreamError = options.observers?.onUpstreamError;

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      log("error", "代理处理请求失败", { message: (err as Error).message });
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "proxy internal error" } }));
      } else {
        res.end();
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = options.resolveSession(req);
    if (!sessionId) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { type: "proxy_error", message: "缺少会话标识，无法确定上游" },
        }),
      );
      return;
    }

    const target = registry.get(sessionId);
    if (!target) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { type: "proxy_error", message: `会话未注册：${sessionId}` },
        }),
      );
      return;
    }

    // 收集请求体（需要改 header 里的 authorization，但 body 不动）
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    const incomingKey = readBearer(req.headers);
    // 占位 key 是预期内的；如果 pi 直接拿真 key 来了，说明配置错了
    if (incomingKey && !isPlaceholderKey(incomingKey)) {
      log("warn", "请求带了非占位 key，仍按注册信息替换", { sessionId });
    }

    // 拼上游 URL：保留 pi 请求的路径与查询
    const targetUrl = buildUpstreamUrl(target.baseUrl, req.url ?? "/");

    // 复制 headers，替换 authorization，去掉只属于 loopback 的
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      const key = k.toLowerCase();
      if (key === "host" || key === "authorization" || key === "content-length") continue;
      headers[key] = Array.isArray(v) ? v.join(", ") : v;
    }
    headers["authorization"] = `Bearer ${target.apiKey}`;
    headers["content-length"] = String(body.length);

    const upstreamUrl = new URL(targetUrl);
    const isHttps = upstreamUrl.protocol === "https:";
    const transport = isHttps ? await import("node:https") : await import("node:http");

    await new Promise<void>((resolve, reject) => {
      const upstreamReq = transport.request(
        {
          protocol: upstreamUrl.protocol,
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port || (isHttps ? 443 : 80),
          path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
          method: req.method,
          headers,
        },
        (upstreamRes) => {
          // 原样回传状态与头
          const resHeaders: Record<string, string | string[]> = {};
          for (const [k, v] of Object.entries(upstreamRes.headers)) {
            if (v === undefined) continue;
            // 去掉 hop-by-hop，避免客户端解压/分块错乱
            const lk = k.toLowerCase();
            if (lk === "content-length" || lk === "transfer-encoding" || lk === "connection") continue;
            resHeaders[k] = v;
          }
          res.writeHead(upstreamRes.statusCode ?? 502, resHeaders);

          const usageSeen = { done: false };

          if (upstreamRes.statusCode && upstreamRes.statusCode >= 400) {
            const errChunks: Buffer[] = [];
            upstreamRes.on("data", (c: Buffer) => errChunks.push(c));
            upstreamRes.on("end", () => {
              const detail = Buffer.concat(errChunks).toString("utf8").slice(0, 1000);
              onUpstreamError?.(sessionId, upstreamRes.statusCode ?? 0, detail);
              res.end(Buffer.concat(errChunks));
              resolve();
            });
            return;
          }

          // ⚠️ 字节级 pipe：不缓冲、不聚合、不等待结束
          upstreamRes.on("data", (chunk: Buffer) => {
            if (onUsage) observeUsage(chunk, sessionId, onUsage, usageSeen);
            res.write(chunk);
          });
          upstreamRes.on("end", () => {
            res.end();
            resolve();
          });
          upstreamRes.on("error", (e) => {
            log("error", "上游响应流出错", { sessionId, message: e.message });
            res.end();
            resolve();
          });
        },
      );

      upstreamReq.on("error", (e) => {
        log("error", "连接上游失败", { sessionId, message: e.message });
        onUpstreamError?.(sessionId, 0, e.message);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: { type: "upstream_unreachable", message: `连不上上游：${e.message}` },
            }),
          );
        } else {
          res.end();
        }
        resolve();
      });

      // 客户端提前断开时，也要把上游请求取消
      res.on("close", () => {
        if (!upstreamReq.destroyed) upstreamReq.destroy();
      });

      upstreamReq.end(body);
    });
  }

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve(addr.port);
    });
  });

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    register(sessionId, target) {
      registry.set(sessionId, target);
      log("info", "proxy 注册会话", { sessionId, baseUrl: target.baseUrl });
    },
    unregister(sessionId) {
      registry.delete(sessionId);
    },
    async dispose() {
      registry.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // 保险：不让长连接挂住退出
        server.closeAllConnections?.();
      });
    },
  };
}

/**
 * 把上游 baseUrl 与请求路径拼起来。
 *
 * pi 请求形如 /v1/chat/completions；上游 baseUrl 形如 https://api.openai.com/v1。
 * 两者都有 /v1 时要避免拼成 /v1/v1/chat/completions。
 */
export function buildUpstreamUrl(baseUrl: string, requestPath: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const reqPath = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;

  const baseUrlObj = new URL(base);
  const basePath = baseUrlObj.pathname.replace(/\/+$/, "");

  // 如果请求路径已经以 base 的路径开头，就直接拼
  if (basePath && (reqPath === basePath || reqPath.startsWith(`${basePath}/`))) {
    return `${baseUrlObj.origin}${reqPath}`;
  }

  return `${base}${reqPath}`;
}
