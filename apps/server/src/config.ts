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

/** 'false' / '0' / 'off' 才算关，其余（含未设置）按开 */
const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback;
  return !['false', '0', 'off', 'no'].includes(value.trim().toLowerCase());
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

export interface AgentSettings {
  /** 沙箱根目录：所有文件工具都被锁在这里 */
  workspace: string;
  shellTimeoutMs: number;
  /** 配额用超了：true 降级到快模型继续跑，false 直接拦下 */
  degradeOnExceed: boolean;
  /** http 工具是否允许打内网地址（默认不许） */
  httpAllowPrivate: boolean;
  /** 审批等多久自动拒绝 */
  approvalTimeoutMs: number;
  /** 一个运行最多几轮「模型 → 工具」 */
  maxSteps: number;
}

export function loadAgentSettings(env: NodeJS.ProcessEnv = process.env): AgentSettings {
  return {
    workspace: env.RAKKO_WORKSPACE ?? process.cwd(),
    shellTimeoutMs: num(env.RAKKO_SHELL_TIMEOUT_MS, 20_000),
    degradeOnExceed: bool(env.RAKKO_DEGRADE_ON_EXCEED, true),
    httpAllowPrivate: bool(env.RAKKO_HTTP_ALLOW_PRIVATE, false),
    approvalTimeoutMs: num(env.RAKKO_APPROVAL_TIMEOUT_MS, 10 * 60_000),
    maxSteps: num(env.RAKKO_MAX_STEPS, 6),
  };
}
