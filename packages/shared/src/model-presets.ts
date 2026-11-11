/**
 * 内置模型预设。
 *
 * 只是 UI 便利，不是权威 —— 用户可改任何字段。
 * cost 必须四字段齐全（不变量 9），缺一个会让 pi 拒绝整个 models.json。
 *
 * 价格单位是「每百万 token 的美元数」，实际值以各供应商官网为准，
 * 这里写的是撰写时的公开定价，用户可自行修改。
 */
import type { ProviderPreset } from "./model-catalog.js";

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    keyHint: "sk-...",
    fetchModels: true,
    models: [
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        contextWindow: 400_000,
        maxOutput: 128_000,
        capabilities: { supportsTools: true, supportsImage: true, supportsThinking: true },
        cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
      },
      {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 mini",
        contextWindow: 400_000,
        maxOutput: 128_000,
        capabilities: { supportsTools: true, supportsImage: true, supportsThinking: true },
        cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
      },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    keyHint: "sk-ant-...",
    models: [
      {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        contextWindow: 200_000,
        maxOutput: 64_000,
        capabilities: {
          supportsTools: true,
          supportsImage: true,
          supportsThinking: true,
          thinkingLevels: ["low", "medium", "high"],
        },
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      },
    ],
  },
  {
    id: "custom",
    name: "自定义 / 自建网关",
    api: "openai-completions",
    baseUrl: "",
    keyHint: "你的 key",
    models: [],
  },
];

export function findPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}
