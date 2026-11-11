/**
 * 生成 pi 的 models.json。
 *
 * 实测（pi 1.4.0）踩到的坑，这里都做了防护：
 *
 * 1. `cost` 必须四字段齐全（input/output/cacheRead/cacheWrite）。
 *    少任何一个 → 整个文件校验失败 → **所有模型消失**，且错误信息只在启动日志里。
 *    所以我们在写盘前自己校验一遍，报出精确是哪个 provider / 哪个模型缺了哪个字段。
 *
 * 2. `apiKey` 支持 `$ENV_VAR` 插值，pi 不做格式校验，字面值直接进 Authorization 头。
 *    我们利用这一点：写 `$RAKKO_PI_API_KEY`，env 里只放占位值，真 key 在 proxy 内存里。
 *
 * 3. 写盘必须原子（临时文件 + rename），否则 pi 可能读到半个文件。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ModelDescriptor, ProviderConfig } from "@rakko/shared";

/** pi 的 models.json 结构。只声明我们用到的字段，其余原样透传。 */
interface PiModelEntry {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  supportsTools?: boolean;
  supportsImage?: boolean;
  supportsThinking?: boolean;
  thinkingLevels?: string[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

interface PiProviderEntry {
  api: string;
  baseUrl: string;
  apiKey: string;
  models: PiModelEntry[];
}

interface PiModelsJson {
  providers: Record<string, PiProviderEntry>;
}

export interface BuildModelsJsonOptions {
  /** proxy 的 loopback 地址，如 http://127.0.0.1:52847/v1 */
  proxyBaseUrl: string;
  /** 插值用的环境变量名，默认 RAKKO_PI_API_KEY */
  apiKeyEnvVar?: string;
  providers: ProviderConfig[];
}

export class ModelsJsonError extends Error {
  constructor(
    message: string,
    readonly details: string[],
  ) {
    super(message);
    this.name = "ModelsJsonError";
  }
}

const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/**
 * 校验单个模型的 cost 四字段。这是保护「整个文件不会因一个字段失效」的核心。
 */
function validateCost(
  providerId: string,
  model: ModelDescriptor,
  problems: string[],
): void {
  const where = `providers.${providerId}.models.${model.id}`;
  if (!model.cost || typeof model.cost !== "object") {
    problems.push(`${where}.cost: 缺失（必须提供 input/output/cacheRead/cacheWrite 四个字段）`);
    return;
  }
  for (const field of COST_FIELDS) {
    const value = model.cost[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      problems.push(`${where}.cost.${field}: 必须是有限数字，实际是 ${JSON.stringify(value)}`);
    } else if (value < 0) {
      problems.push(`${where}.cost.${field}: 不能为负，实际是 ${value}`);
    }
  }
}

function validateProvider(provider: ProviderConfig, problems: string[]): void {
  const where = `providers.${provider.id}`;

  if (!provider.id || !/^[a-zA-Z0-9_-]+$/.test(provider.id)) {
    problems.push(`${where}.id: 必须是非空的字母数字下划线组合`);
  }
  if (!provider.baseUrl) {
    problems.push(`${where}.baseUrl: 不能为空`);
  }
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    problems.push(`${where}.models: 至少要有一个模型`);
    return;
  }

  const seen = new Set<string>();
  for (const model of provider.models) {
    if (!model.id) {
      problems.push(`${where}.models: 存在没有 id 的模型`);
      continue;
    }
    if (seen.has(model.id)) {
      problems.push(`${where}.models.${model.id}: 模型 id 重复`);
    }
    seen.add(model.id);

    if (!(model.contextWindow > 0)) {
      problems.push(`${where}.models.${model.id}.contextWindow: 必须大于 0`);
    }
    if (!(model.maxOutput > 0)) {
      problems.push(`${where}.models.${model.id}.maxOutput: 必须大于 0`);
    }
    validateCost(provider.id, model, problems);
  }
}

/**
 * 构建 models.json 内容。校验不通过抛 ModelsJsonError，**不返回半成品**。
 *
 * 所有 provider 都指向 proxy 的 loopback 地址，而不是各自的上游。
 * proxy 根据请求路径反查该用哪个上游和哪把 key。
 */
export function buildModelsJson(options: BuildModelsJsonOptions): PiModelsJson {
  const { proxyBaseUrl, providers } = options;
  const apiKeyEnvVar = options.apiKeyEnvVar ?? "RAKKO_PI_API_KEY";

  const problems: string[] = [];

  if (!proxyBaseUrl) {
    problems.push("proxyBaseUrl: 不能为空");
  }
  if (providers.length === 0) {
    problems.push("providers: 至少配置一个供应商");
  }

  const ids = new Set<string>();
  for (const provider of providers) {
    if (ids.has(provider.id)) {
      problems.push(`providers.${provider.id}: provider id 重复`);
    }
    ids.add(provider.id);
    validateProvider(provider, problems);
  }

  if (problems.length > 0) {
    throw new ModelsJsonError(
      `models.json 校验未通过（${problems.length} 处问题）。` +
        `这些字段缺失会让 pi 拒绝整个文件、所有模型消失。`,
      problems,
    );
  }

  const result: PiModelsJson = { providers: {} };

  for (const provider of providers) {
    result.providers[provider.id] = {
      api: provider.api,
      // 一律指向 proxy：真上游地址由 proxy 自己记着，不写进 pi 读得到的文件
      baseUrl: proxyBaseUrl,
      apiKey: `$${apiKeyEnvVar}`,
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxOutput: model.maxOutput,
        supportsTools: model.capabilities.supportsTools,
        supportsImage: model.capabilities.supportsImage,
        supportsThinking: model.capabilities.supportsThinking,
        ...(model.capabilities.thinkingLevels
          ? { thinkingLevels: model.capabilities.thinkingLevels }
          : {}),
        cost: {
          input: model.cost.input,
          output: model.cost.output,
          cacheRead: model.cost.cacheRead,
          cacheWrite: model.cost.cacheWrite,
        },
      })),
    };
  }

  return result;
}

/**
 * 原子写入 models.json。
 *
 * 先写临时文件再 rename —— pi 可能同时在读这个文件，
 * 直接用 writeFile 会让它读到截断的 JSON。
 */
export async function writeModelsJson(
  agentHome: string,
  options: BuildModelsJsonOptions,
): Promise<string> {
  const content = buildModelsJson(options);
  const target = path.join(agentHome, "models.json");
  const tmp = `${target}.${process.pid}.tmp`;

  await fs.mkdir(agentHome, { recursive: true });
  const text = `${JSON.stringify(content, null, 2)}\n`;
  await fs.writeFile(tmp, text, "utf8");

  // 回读校验：确认落盘内容与内存一致（磁盘可能满、可能被截断）
  const readBack = await fs.readFile(tmp, "utf8");
  if (readBack !== text) {
    await fs.rm(tmp, { force: true });
    throw new ModelsJsonError("models.json 写入后回读不一致", [
      `期望 ${text.length} 字节，实际 ${readBack.length} 字节`,
    ]);
  }

  await fs.rename(tmp, target);
  return target;
}
