/**
 * 供应商预设。
 *
 * 只收**能用 openai-completions 协议直连**的服务。
 * pi 还支持 anthropic-messages 等协议，但内置运行时裁掉了对应 SDK
 * （见 docs/local-dev.md「内置 pi 运行时」），所以这里不放那些项，
 * 免得用户选了之后跑不通。
 *
 * baseUrl 是各家公开的 OpenAI 兼容端点，用户仍可改。
 */

/** 自定义弹窗的预填值 */
export interface ProviderPreset {
  /** 显示名称 */
  name: string;
  /** 上游根地址，不含 /chat/completions */
  baseUrl: string;
  /** 该服务商的模型列表页，给不知道该填什么的人一个去处 */
  modelsUrl?: string;
}

export interface PresetGroup {
  label: string;
  items: ProviderPreset[];
}

export const PROVIDER_PRESETS: PresetGroup[] = [
  {
    label: "国内网关",
    items: [
      {
        name: "均瑶内网网关",
        baseUrl: "https://d-openai.juneyaoair.com/llm/v1",
      },
      {
        name: "深度求索",
        baseUrl: "https://api.deepseek.com/v1",
        modelsUrl: "https://platform.deepseek.com/api-docs",
      },
      {
        name: "月之暗面",
        baseUrl: "https://api.moonshot.cn/v1",
        modelsUrl: "https://platform.moonshot.cn/docs",
      },
      {
        name: "阿里云百炼",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        modelsUrl: "https://help.aliyun.com/zh/model-studio",
      },
      {
        name: "智谱",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      },
    ],
  },
  {
    label: "国际",
    items: [
      {
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
      },
      {
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        modelsUrl: "https://openrouter.ai/models",
      },
    ],
  },
  {
    label: "本机",
    items: [
      {
        name: "Ollama",
        baseUrl: "http://localhost:11434/v1",
      },
      {
        name: "LM Studio",
        baseUrl: "http://localhost:1234/v1",
      },
    ],
  },
];
