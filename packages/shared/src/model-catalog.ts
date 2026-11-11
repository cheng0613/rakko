/**
 * 模型目录：内置预设 + 用户自定义。
 *
 * 这一层最终会写成 pi 要求的 `models.json`。实测（pi 1.4.0）：
 * - `apiKey` 支持 `$ENV_VAR` 插值
 * - `cost` 必须同时有 input/output/cacheRead/cacheWrite 四个字段，
 *   缺任何一个都会让**整个 models.json 校验失败、所有模型消失**
 */

/** pi 原生支持的四种 api 形态。首期只实现 openai-completions。 */
export type PiApiForm =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelCapabilities {
  supportsTools: boolean;
  supportsImage: boolean;
  supportsThinking: boolean;
  /** 支持的思考档位，如 ["low","medium","high"] */
  thinkingLevels?: string[];
}

export interface ModelDescriptor {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
  capabilities: ModelCapabilities;
  cost: ModelCost;
}

export interface ProviderConfig {
  id: string;
  name: string;
  api: PiApiForm;
  /** 真实上游地址（我们直连），proxy 会用它转发 */
  baseUrl: string;
  models: ModelDescriptor[];
}

/** 内置预设：只是 UI 便利，不是权威。用户可改任何字段。 */
export interface ProviderPreset extends Omit<ProviderConfig, "id"> {
  id: string;
  /** 是否支持 GET /v1/models 拉取最新模型列表 */
  fetchModels?: boolean;
  /** key 输入框的占位提示，如 "sk-..." */
  keyHint?: string;
}
