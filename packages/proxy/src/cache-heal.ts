/**
 * 缓存字段自愈。
 *
 * 问题：某些上游（自建网关、代理转发到 Azure/OpenAI 的服务）
 * 不认识 `prompt_cache_key` / `prompt_cache_retention`，直接返回 400。
 * 用户看到的是「模型报错」，实际只是两个可选字段。
 *
 * 做法：收到**可靠的 400** 时，移除这两个字段重发一次。
 * 成功率记进本地学习文件，下次同一线路直接不带。
 *
 * 严格的进入条件（照 Cindy 的规则，宁可不试也不要冒进）：
 *   - 必须是 400 且响应体不含鉴权/限流/上下文/模型/缺必填/类型错误
 *   - 请求体里确实含这两个字段之一
 *   - 同一线路同一输入**最多试一次**
 *
 * 为什么可以这么做：这两个字段只影响缓存命中率，不影响语义。
 * 移除后最多是「慢一点（没命中缓存）」，不会改变回答内容。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** 可自愈的字段。只允许这两个，不要扩。 */
export const HEALABLE_FIELDS = ["prompt_cache_key", "prompt_cache_retention"] as const;
export type HealableField = (typeof HEALABLE_FIELDS)[number];

/** 明确不该重试的错误特征（这些移除缓存字段也没用） */
const NON_HEALABLE_PATTERNS = [
  /unauthorized/i,
  /authentication/i,
  /invalid.?api.?key/i,
  /api.?key/i,
  /forbidden/i,
  /rate.?limit/i,
  /quota/i,
  /insufficient/i,
  /context.?length/i,
  /too.?many.?tokens/i,
  /maximum.?context/i,
  /model.?not.?found/i,
  /no.?such.?model/i,
  /does.?not.?exist/i,
  /missing.?required/i,
  /required.?parameter/i,
  /is.?required/i,
  /invalid.?type/i,
  /unsupported.?parameter/i,
  /unknown.?parameter/i,
];

export interface HealDecision {
  /** 是否值得重试 */
  retry: boolean;
  /** 重试时要移除的字段（实际存在的那些） */
  strip: HealableField[];
  /** 为什么这么判断，用于日志与学习 */
  reason: string;
  /** explicit = 上游明确拒收缓存字段；opaque = 猜测 */
  kind: "explicit" | "opaque";
}

/**
 * 判断一次 400 是否值得移除缓存字段重试。
 *
 * @param body 原始请求体（已解析）
 * @param statusCode 上游状态码
 * @param responseBody 上游响应体（前若干字节足够）
 */
export function decideHeal(
  body: Record<string, unknown>,
  statusCode: number,
  responseBody: string,
): HealDecision {
  const present = HEALABLE_FIELDS.filter((f) => f in body);
  if (present.length === 0) {
    return { retry: false, strip: [], reason: "请求里没有缓存字段", kind: "opaque" };
  }

  if (statusCode !== 400) {
    return {
      retry: false,
      strip: [],
      reason: `状态码 ${statusCode} 不是 400`,
      kind: "opaque",
    };
  }

  // 先看是不是明确点名了缓存字段
  const lower = responseBody.toLowerCase();
  const namesCacheField = HEALABLE_FIELDS.some((f) => lower.includes(f.toLowerCase()));

  if (namesCacheField) {
    return {
      retry: true,
      strip: present,
      reason: "上游明确提到缓存字段",
      kind: "explicit",
    };
  }

  // 再看是不是明确别的原因
  for (const p of NON_HEALABLE_PATTERNS) {
    if (p.test(responseBody)) {
      return {
        retry: false,
        strip: [],
        reason: `响应命中不可自愈特征：${p.source}`,
        kind: "opaque",
      };
    }
  }

  // 400 但原因不明：值得试一次
  return {
    retry: true,
    strip: present,
    reason: "400 原因不明，尝试移除缓存字段",
    kind: "opaque",
  };
}

// ─────────────────────────────────────────────
// 学习文件
// ─────────────────────────────────────────────

/** 学习记录的有效期 */
export const EXPLICIT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
export const OPAQUE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时

export interface LearnedRoute {
  /** 线路身份：协议 + 真实端点（哈希过） */
  route: string;
  /** 哪些字段要移除 */
  strip: string[];
  kind: "explicit" | "opaque";
  /** 学习时间 */
  learnedAt: number;
}

export interface LearningStoreFile {
  version: 1;
  routes: LearnedRoute[];
}

/**
 * 线路身份。
 *
 * 端点包含路径、端口、查询参数 —— 换一条路径就是另一条线路。
 * 哈希后存，不保存原始 URL（可能含凭证）。
 */
export function routeIdentity(protocol: string, endpoint: string): string {
  return createHash("sha256").update(`${protocol}\n${endpoint}`).digest("hex").slice(0, 32);
}

export class LearningStore {
  private cache: LearningStoreFile | null = null;
  /** 运行期学习记录（含尚未落盘的） */
  private memory: LearningStoreFile | null = null;

  constructor(private readonly filePath: string) {}

  private async read(): Promise<LearningStoreFile> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<LearningStoreFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.routes)) {
        // 损坏文件：保留原样，当作没学过
        return { version: 1, routes: [] };
      }
      this.cache = { version: 1, routes: parsed.routes };
      if (!this.memory) this.memory = { version: 1, routes: [...parsed.routes] };
      return this.cache;
    } catch {
      const empty: LearningStoreFile = { version: 1, routes: [] };
      // 文件不存在或损坏：初始化内存，后续 learn 都写这里
      if (!this.memory) this.memory = { version: 1, routes: [] };
      return empty;
    }
  }

  private async write(data: LearningStoreFile): Promise<void> {
    const text = `${JSON.stringify(data, null, 2)}
`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // 直接写目标文件。不做 rename：
    // Windows 上 rename 到已存在目标会 EPERM，先删再 rename 又有并发窗口。
    // 学习记录是可重建的缓存，不值得为原子性付出这些复杂度。
    await fs.writeFile(this.filePath, text, "utf8");
    this.cache = data;
    this.memory = data;
  }

  /** 查这条线路有没有学到的规则（自动过滤过期） */
  async lookup(route: string, now = Date.now()): Promise<LearnedRoute | null> {
    const data = this.memory ?? (await this.read());
    const hit = data.routes.find((r) => r.route === route);
    if (!hit) return null;
    const ttl = hit.kind === "explicit" ? EXPLICIT_TTL_MS : OPAQUE_TTL_MS;
    if (now - hit.learnedAt > ttl) {
      // 过期：清掉
      await this.write({
        version: 1,
        routes: data.routes.filter((r) => r.route !== route),
      });
      return null;
    }
    return hit;
  }

  /** 记录学到的东西 */
  /**
   * 记录学到的东西。
   *
   * **只写内存，不写盘。** 请求路径上不做文件 IO：
   *   1. 不阻塞用户响应
   *   2. 避开 Windows 上 rename 被占用/删目录的 EPERM/ENOENT
   * 落盘由 flush() 在应用退出时统一做。
   */
  async learn(input: {
    route: string;
    strip: string[];
    kind: "explicit" | "opaque";
    now?: number;
  }): Promise<void> {
    if (!this.memory) {
      this.memory = await this.read();
    }
    const next: LearnedRoute = {
      route: input.route,
      strip: input.strip,
      kind: input.kind,
      learnedAt: input.now ?? Date.now(),
    };
    this.memory.routes = this.memory.routes.filter((r) => r.route !== input.route);
    this.memory.routes.push(next);
  }

  /** 把内存里的学习记录落盘。应用退出时调一次。 */
  async flush(): Promise<void> {
    if (!this.memory) return;
    await this.write(this.memory).catch(() => {
      /* 落盘失败不影响运行 */
    });
  }

  /** 内存里的学习记录（供测试与调试查看） */
  peek(): LearningStoreFile | null {
    return this.memory;
  }

  /** 清掉全部学习记录 */
  async clear(): Promise<void> {
    await this.write({ version: 1, routes: [] });
  }

  /** 测试用 */
  invalidate(): void {
    this.cache = null;
    this.memory = null;
  }
}

/** 从请求体里移除缓存字段，返回新对象（不改原对象） */
export function stripCacheFields<T extends Record<string, unknown>>(body: T): T {
  const copy = { ...body };
  for (const f of HEALABLE_FIELDS) {
    delete copy[f];
  }
  return copy;
}
