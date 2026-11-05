/**
 * 运行配置：全部来自环境变量，代码里不出现任何 key。
 *
 * 默认值指向腾讯 tokenhub 的 OpenAI 兼容网关；换个供应商只改 RAKKO_BASE_URL。
 */

import type { ModelTier } from '@rakko/core';

export interface ProviderSettings {
  baseUrl: string;
  apiKey: string;
  models: Record<ModelTier, string>;
  timeoutMs: number;
  firstChunkTimeoutMs: number;
}

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function loadProviderSettings(env: NodeJS.ProcessEnv = process.env): ProviderSettings {
  return {
    baseUrl: env.RAKKO_BASE_URL ?? 'https://tokenhub.tencentmaas.com/v1',
    apiKey: env.RAKKO_API_KEY ?? '',
    models: {
      standard: env.RAKKO_MODEL_STANDARD ?? 'deepseek-v4-pro',
      fast: env.RAKKO_MODEL_FAST ?? 'deepseek/deepseek-flash',
    },
    timeoutMs: num(env.RAKKO_TIMEOUT_MS, 180_000),
    firstChunkTimeoutMs: num(env.RAKKO_FIRST_CHUNK_MS, 45_000),
  };
}
