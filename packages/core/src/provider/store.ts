/**
 * 运营商（provider）配置的持久化。
 *
 * 两条硬约束：
 *
 * 1. **key 加密落盘，不存明文。**
 *    加密用的是宿主注入的端口（Electron 里是 safeStorage），
 *    所以这个模块不 import electron —— 由调用方把加解密能力传进来。
 *
 * 2. **key 永不下发渲染进程。**
 *    读配置时返回的 key 一律是掩码（`sk-...abcd`），
 *    真值只在主进程启动会话时用一次。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ModelCost, ModelDescriptor, PiApiForm, ProviderConfig } from "@rakko/shared";

export const PROVIDERS_FILENAME = "providers.json";

/**
 * 加解密端口。由平台注入。
 *
 * - Electron：`safeStorage.encryptString` / `decryptString`
 * - 测试 / 无 GUI：用平文实现（会显式标注 insecure）
 */
export interface SecretBox {
  /** 是否真的做了加密。false 时写盘的是平文，只用于开发与测试 */
  readonly secure: boolean;
  seal(plain: string): Promise<string>;
  open(sealed: string): Promise<string>;
}

/** 写进磁盘的形状。key 是加密后的密文（或开发期的平文）。 */
interface StoredProvider {
  id: string;
  name: string;
  api: PiApiForm;
  baseUrl: string;
  models: ModelDescriptor[];
  /** 加密后的 key。空字符串表示还没填 */
  sealedKey: string;
  createdAt: number;
  updatedAt: number;
}

interface StoredFile {
  version: 1;
  providers: StoredProvider[];
}

/** 给渲染进程看的形状。**没有 key。** */
export interface ProviderView {
  id: string;
  name: string;
  api: PiApiForm;
  baseUrl: string;
  models: ModelDescriptor[];
  /** 掩码后的 key，用于显示「已配置」；未配置时为空 */
  keyMask: string;
  hasKey: boolean;
  createdAt: number;
  updatedAt: number;
}

export class ProviderStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | "NOT_FOUND"
      | "DUPLICATE_ID"
      | "INVALID"
      | "CORRUPT_FILE"
      | "DECRYPT_FAILED",
  ) {
    super(message);
    this.name = "ProviderStoreError";
  }
}

const REQUIRED_COST_FIELDS: ReadonlyArray<keyof ModelCost> = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
];

/**
 * 校验一个 provider 配置。
 *
 * 与 models.json 的校验同口径 —— 这里放过的问题，到 pi 那边会让整个
 * models.json 失效、所有模型消失。
 */
export function validateProviderConfig(input: {
  id: string;
  name: string;
  api: PiApiForm;
  baseUrl: string;
  models: ModelDescriptor[];
}): string[] {
  const problems: string[] = [];

  if (!input.id || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.id)) {
    problems.push("id 必须是 1-64 位的字母、数字、下划线或连字符");
  }
  if (!input.name.trim()) {
    problems.push("name 不能为空");
  }
  if (!input.baseUrl.trim()) {
    problems.push("baseUrl 不能为空");
  } else {
    try {
      const u = new URL(input.baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        problems.push("baseUrl 必须是 http 或 https");
      }
    } catch {
      problems.push("baseUrl 不是合法 URL");
    }
  }
  if (!Array.isArray(input.models) || input.models.length === 0) {
    problems.push("至少要有一个模型");
  }

  const seen = new Set<string>();
  for (const m of input.models ?? []) {
    if (!m.id) {
      problems.push("存在没有 id 的模型");
      continue;
    }
    if (seen.has(m.id)) problems.push(`模型 id 重复：${m.id}`);
    seen.add(m.id);

    if (!(m.contextWindow > 0)) problems.push(`模型 ${m.id} 的 contextWindow 必须大于 0`);
    if (!(m.maxOutput > 0)) problems.push(`模型 ${m.id} 的 maxOutput 必须大于 0`);

    for (const field of REQUIRED_COST_FIELDS) {
      const v = m.cost?.[field];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        problems.push(
          `模型 ${m.id} 的 cost.${field} 必须是 >= 0 的有限数字（缺字段会让 pi 拒绝整个 models.json）`,
        );
      }
    }
  }

  return problems;
}

/** 生成 key 掩码：只露前 3 位与后 4 位 */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "•".repeat(key.length);
  const head = key.slice(0, 3);
  const tail = key.slice(-4);
  return `${head}${"•".repeat(Math.min(6, key.length - 7))}${tail}`;
}

export class ProviderStore {
  private cache: StoredFile | null = null;

  constructor(
    private readonly filePath: string,
    private readonly secretBox: SecretBox,
  ) {}

  static defaultPath(baseDir: string): string {
    return path.join(baseDir, PROVIDERS_FILENAME);
  }

  private async read(): Promise<StoredFile> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoredFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.providers)) {
        throw new ProviderStoreError("providers.json 结构不对", "CORRUPT_FILE");
      }
      this.cache = { version: 1, providers: parsed.providers };
      return this.cache;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = { version: 1, providers: [] };
        return this.cache;
      }
      if (e instanceof ProviderStoreError) throw e;
      throw new ProviderStoreError(
        `读 providers.json 失败：${(e as Error).message}`,
        "CORRUPT_FILE",
      );
    }
  }

  private async write(data: StoredFile): Promise<void> {
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const text = `${JSON.stringify(data, null, 2)}\n`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(tmp, text, "utf8");

    const readBack = await fs.readFile(tmp, "utf8");
    if (readBack !== text) {
      await fs.rm(tmp, { force: true });
      throw new ProviderStoreError("providers.json 写入后回读不一致", "INVALID");
    }
    await fs.rename(tmp, this.filePath);
    this.cache = data;
  }

  /** 列出全部（不含 key，只有掩码） */
  async list(): Promise<ProviderView[]> {
    const data = await this.read();
    const out: ProviderView[] = [];
    for (const p of data.providers) {
      let hasKey = false;
      let keyMask = "";
      if (p.sealedKey) {
        try {
          const plain = await this.secretBox.open(p.sealedKey);
          hasKey = plain.length > 0;
          keyMask = maskKey(plain);
        } catch {
          // 解不开（换了机器 / 密钥变了）：显示为「已配置但不可用」
          hasKey = false;
          keyMask = "（无法解密）";
        }
      }
      out.push({
        id: p.id,
        name: p.name,
        api: p.api,
        baseUrl: p.baseUrl,
        models: p.models,
        hasKey,
        keyMask,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      });
    }
    return out;
  }

  /** 取单个（不含 key） */
  async get(id: string): Promise<ProviderView | null> {
    const all = await this.list();
    return all.find((p) => p.id === id) ?? null;
  }

  /**
   * 取出带真 key 的完整配置。**只给主进程启动会话时用。**
   */
  async resolveForRuntime(id: string): Promise<{ config: ProviderConfig; apiKey: string }> {
    const data = await this.read();
    const p = data.providers.find((x) => x.id === id);
    if (!p) throw new ProviderStoreError(`找不到 provider：${id}`, "NOT_FOUND");

    let apiKey = "";
    if (p.sealedKey) {
      try {
        apiKey = await this.secretBox.open(p.sealedKey);
      } catch (e) {
        throw new ProviderStoreError(
          `provider ${id} 的 key 解密失败，请重新填写：${(e as Error).message}`,
          "DECRYPT_FAILED",
        );
      }
    }

    return {
      config: { id: p.id, name: p.name, api: p.api, baseUrl: p.baseUrl, models: p.models },
      apiKey,
    };
  }

  /** 新建 */
  async create(input: {
    id: string;
    name: string;
    api: PiApiForm;
    baseUrl: string;
    models: ModelDescriptor[];
    apiKey?: string;
  }): Promise<ProviderView> {
    const problems = validateProviderConfig(input);
    if (problems.length > 0) {
      throw new ProviderStoreError(`配置不合法：${problems.join("；")}`, "INVALID");
    }

    const data = await this.read();
    if (data.providers.some((p) => p.id === input.id)) {
      throw new ProviderStoreError(`provider id 已存在：${input.id}`, "DUPLICATE_ID");
    }

    const now = Date.now();
    const stored: StoredProvider = {
      id: input.id,
      name: input.name.trim(),
      api: input.api,
      baseUrl: input.baseUrl.trim(),
      models: input.models,
      sealedKey: input.apiKey ? await this.secretBox.seal(input.apiKey) : "",
      createdAt: now,
      updatedAt: now,
    };

    await this.write({ version: 1, providers: [...data.providers, stored] });
    return (await this.get(input.id))!;
  }

  /**
   * 更新。
   *
   * `apiKey` 三态：
   *   - undefined：保持不变
   *   - ""：清空
   *   - 非空：替换
   */
  async update(
    id: string,
    patch: {
      name?: string;
      api?: PiApiForm;
      baseUrl?: string;
      models?: ModelDescriptor[];
      apiKey?: string;
    },
  ): Promise<ProviderView> {
    const data = await this.read();
    const idx = data.providers.findIndex((p) => p.id === id);
    if (idx < 0) throw new ProviderStoreError(`找不到 provider：${id}`, "NOT_FOUND");

    const current = data.providers[idx]!;
    const merged = {
      id: current.id,
      name: patch.name ?? current.name,
      api: patch.api ?? current.api,
      baseUrl: patch.baseUrl ?? current.baseUrl,
      models: patch.models ?? current.models,
    };

    const problems = validateProviderConfig(merged);
    if (problems.length > 0) {
      throw new ProviderStoreError(`配置不合法：${problems.join("；")}`, "INVALID");
    }

    let sealedKey = current.sealedKey;
    if (patch.apiKey !== undefined) {
      sealedKey = patch.apiKey === "" ? "" : await this.secretBox.seal(patch.apiKey);
    }

    const next: StoredProvider = {
      ...current,
      ...merged,
      sealedKey,
      updatedAt: Date.now(),
    };

    const providers = [...data.providers];
    providers[idx] = next;
    await this.write({ version: 1, providers });
    return (await this.get(id))!;
  }

  /** 删除 */
  async remove(id: string): Promise<void> {
    const data = await this.read();
    const providers = data.providers.filter((p) => p.id !== id);
    if (providers.length === data.providers.length) {
      throw new ProviderStoreError(`找不到 provider：${id}`, "NOT_FOUND");
    }
    await this.write({ version: 1, providers });
  }

  /** 测试用：清掉内存缓存 */
  invalidate(): void {
    this.cache = null;
  }
}

/**
 * 开发/测试用的平文 SecretBox。
 *
 * 明确标注 insecure，避免误用到生产路径。
 */
export function createPlaintextSecretBox(): SecretBox {
  return {
    secure: false,
    async seal(plain) {
      return `plain:${Buffer.from(plain, "utf8").toString("base64")}`;
    },
    async open(sealed) {
      if (!sealed.startsWith("plain:")) throw new Error("不是平文封装的 key");
      return Buffer.from(sealed.slice(6), "base64").toString("utf8");
    },
  };
}
