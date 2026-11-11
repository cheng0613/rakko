/**
 * 内置模型预设。
 *
 * 只是 UI 便利，不是权威 —— 用户可改任何字段。
 * cost 必须四字段齐全（不变量 9），缺一个会让 pi 拒绝整个 models.json。
 *
 * 价格单位：每百万 token 的美元数。这里是占位值，用户应自行按实际计费修改；
 * 若上游是内部网关不按 token 计费，保持 0 即可（pi 会算成 0 成本）。
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
    id: "juneyao",
    name: "均瑶内网网关",
    api: "openai-completions",
    baseUrl: "https://d-openai.juneyaoair.com/llm/v1",
    keyHint: "网关下发的 key",
    fetchModels: true,
    models: [
      // 以下是实测可用的模型（2026-11-11）。tool calling / 流式都已验证。
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        contextWindow: 128_000,
        maxOutput: 8_192,
        capabilities: { supportsTools: true, supportsImage: false, supportsThinking: true },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        contextWindow: 128_000,
        maxOutput: 8_192,
        capabilities: { supportsTools: true, supportsImage: false, supportsThinking: true },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "kimi-k2.7-code",
        name: "Kimi K2.7 Code",
        contextWindow: 128_000,
        maxOutput: 8_192,
        capabilities: { supportsTools: true, supportsImage: false, supportsThinking: true },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "qwen3.5-plus",
        name: "Qwen 3.5 Plus",
        contextWindow: 128_000,
        maxOutput: 8_192,
        capabilities: { supportsTools: true, supportsImage: false, supportsThinking: true },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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

/**
 * 已知的上游坑，给 UI 提示用。
 *
 * 这些不是缺陷列表，是实测记录 —— 避免用户碰到同一个问题以为是我们的 bug。
 */
export interface ModelCaveat {
  providerId: string;
  modelId: string;
  note: string;
}

export const MODEL_CAVEATS: ModelCaveat[] = [
  {
    providerId: "juneyao",
    modelId: "glm-5.2",
    note: "推理占用较高：max_tokens 小于约 500 时会全部消耗在推理上，正文为空。建议 maxOutput 至少 2048。",
  },
  {
    providerId: "juneyao",
    modelId: "minimax-m3",
    note: "正文里会带裸的 <think> 标签，需要在 UI 侧剥离。",
  },
  {
    providerId: "juneyao",
    modelId: "qwen3.5-plus",
    note: "网关路由下会自称 OpenAI，模型身份不可靠。",
  },
];
