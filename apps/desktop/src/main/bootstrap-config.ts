/**
 * 从环境变量读一个可用于开发的 provider。
 *
 * 这是 P0 的临时通道 —— 设置页（P0 步骤 14）会取代它。
 * **key 只在这一层使用，永不下发到渲染进程。**
 *
 * 需要的变量：
 *   RAKKO_BASE_URL   如 https://api.openai.com/v1
 *   RAKKO_MODEL      如 gpt-5.4
 *   RAKKO_API_KEY    真实 key
 * 可选：
 *   RAKKO_PROVIDER_ID    默认 "boot"
 *   RAKKO_PROVIDER_NAME  默认 "Bootstrap"
 *   RAKKO_CONTEXT_WINDOW 默认 128000
 *   RAKKO_MAX_OUTPUT     默认 8192
 */
import type { ModelSummary, ProviderConfig } from "@rakko/shared";

export interface BootstrapReadResult {
  providers: ProviderConfig[];
  apiKey: string;
  /** 缺什么，用于给用户明确提示 */
  missing: string[];
}

export function readBootstrapProviders(env: NodeJS.ProcessEnv = process.env): BootstrapReadResult {
  const baseUrl = (env["RAKKO_BASE_URL"] ?? "").trim();
  const modelId = (env["RAKKO_MODEL"] ?? "").trim();
  const apiKey = (env["RAKKO_API_KEY"] ?? "").trim();

  const missing: string[] = [];
  if (!baseUrl) missing.push("RAKKO_BASE_URL");
  if (!modelId) missing.push("RAKKO_MODEL");
  if (!apiKey) missing.push("RAKKO_API_KEY");

  if (missing.length > 0) return { providers: [], apiKey: "", missing };

  const providerId = (env["RAKKO_PROVIDER_ID"] ?? "boot").trim() || "boot";
  const providerName = (env["RAKKO_PROVIDER_NAME"] ?? "Bootstrap").trim() || "Bootstrap";
  const contextWindow = toPositiveInt(env["RAKKO_CONTEXT_WINDOW"], 128_000);
  const maxOutput = toPositiveInt(env["RAKKO_MAX_OUTPUT"], 8_192);

  return {
    missing: [],
    apiKey,
    providers: [
      {
        id: providerId,
        name: providerName,
        api: "openai-completions",
        baseUrl,
        models: [
          {
            id: modelId,
            name: modelId,
            contextWindow,
            maxOutput,
            capabilities: { supportsTools: true, supportsImage: false, supportsThinking: false },
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    ],
  };
}

/** 把 provider 压成展示用的摘要，不含 key / baseUrl */
export function toModelSummaries(providers: ProviderConfig[]): ModelSummary[] {
  return providers.flatMap((p) =>
    p.models.map((m) => ({
      providerId: p.id,
      providerName: p.name,
      modelId: m.id,
      modelName: m.name,
      contextWindow: m.contextWindow,
    })),
  );
}

function toPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
