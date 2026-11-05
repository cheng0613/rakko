/**
 * 网关：介于「运行」和「provider」之间的一层策略。
 *
 * 责任只有一条 —— 主模型不行时，让任务继续跑：
 *   1. 熔断按模型中档位分开计数，连续失败就开门，冷却后只放一个探针；
 *   2. 还没吐出任何回答时，自动降级到快模型，并通过 fallback 块告知上层；
 *   3. 已经吐出内容就不能换模型（会重复），直接报错停下。
 *
 * 配额层面的「用超了降级」由调用方决定起点档位，这里不读配额。
 */

import { CircuitBreaker } from './circuit-breaker.js';
import type { ModelProvider, ProviderChunk } from './provider.js';
import { ProviderHttpError, ProviderTimeoutError } from './providers/openai-compatible.js';

export type ModelTier = 'standard' | 'fast';

export interface GatewayRequest {
  runId: string;
  prompt: string;
  tier: ModelTier;
  signal?: AbortSignal;
}

/** 网关比 provider 多一类 fallback：告诉上层「换模型了」。 */
export type GatewayChunk = ProviderChunk | { kind: 'fallback'; from: ModelTier; to: ModelTier; reason: string };

export interface ProviderGatewayOptions {
  provider: ModelProvider;
  models: Record<ModelTier, string>;
  /** 默认每档一个熔断器 */
  breakers?: Partial<Record<ModelTier, CircuitBreaker>>;
  /** 首字超时。这些模型会先思考很久，别设太小 */
  firstChunkTimeoutMs?: number;
}

export class ProviderUnavailable extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProviderUnavailable';
  }
}

const describe = (error: unknown): string => {
  if (error instanceof ProviderHttpError) return `接口返回 ${error.status}`;
  if (error instanceof ProviderTimeoutError) return error.message;
  if (error instanceof Error) return error.message;
  return '未知错误';
};

export class ProviderGateway {
  readonly models: Record<ModelTier, string>;
  readonly providerId: string;
  private readonly provider: ModelProvider;
  private readonly breakers: Record<ModelTier, CircuitBreaker>;
  private readonly firstChunkTimeoutMs: number;

  constructor(options: ProviderGatewayOptions) {
    this.provider = options.provider;
    this.providerId = options.provider.id;
    this.models = options.models;
    this.breakers = {
      standard: options.breakers?.standard ?? new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000 }),
      fast: options.breakers?.fast ?? new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000 }),
    };
    this.firstChunkTimeoutMs = options.firstChunkTimeoutMs ?? 45_000;
  }

  breakerState(tier: ModelTier): string {
    return this.breakers[tier].getState();
  }

  async *stream(request: GatewayRequest): AsyncIterable<GatewayChunk> {
    const order: ModelTier[] = request.tier === 'fast' ? ['fast'] : ['standard', 'fast'];

    let emitted = false;
    let lastError: unknown = null;
    let pendingFallback: { from: ModelTier; reason: string } | null = null;

    for (const tier of order) {
      if (emitted) break;
      const breaker = this.breakers[tier];

      if (pendingFallback) {
        yield {
          kind: 'fallback',
          from: pendingFallback.from,
          to: tier,
          reason: `${this.models[pendingFallback.from]} 不可用（${pendingFallback.reason}），已降级到 ${this.models[tier]}`,
        };
        pendingFallback = null;
      }

      if (!breaker.canPass()) {
        lastError = new ProviderUnavailable(`模型 ${this.models[tier]} 正在熔断，暂停调用`);
        // 跳过也要告知上层：用户看到的是「换了模型」，不是「偷偷变慢」
        if (tier !== order[order.length - 1]) pendingFallback = { from: tier, reason: '正在熔断，暂停调用' };
        continue;
      }

      let started = false;
      try {
        for await (const chunk of this.guard(
          this.provider.stream({
            runId: request.runId,
            prompt: request.prompt,
            model: this.models[tier],
            ...(request.signal ? { signal: request.signal } : {}),
          }),
        )) {
          if (!started) {
            started = true;
            breaker.recordSuccess();
          }
          if (chunk.kind === 'delta' || chunk.kind === 'tool_call') emitted = true;
          yield chunk;
        }
        return;
      } catch (error) {
        breaker.recordFailure();
        lastError = error;

        if (emitted) {
          throw new ProviderUnavailable('模型输出中途失败，本次运行已停止', error);
        }
        pendingFallback = { from: tier, reason: describe(error) };
      }
    }

    throw new ProviderUnavailable('模型服务暂时不可用，快模型也没接上，请稍后重试', lastError);
  }

  /** 首字超时单独判：连不上和算得慢是两种故障。 */
  private async *guard(source: AsyncIterable<ProviderChunk>): AsyncIterable<ProviderChunk> {
    const iterator = source[Symbol.asyncIterator]();
    try {
      const first = await this.withTimeout(iterator.next());
      if (first.done) return;
      yield first.value;

      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await iterator.return?.(undefined);
    }
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProviderTimeoutError('模型首字超时')), this.firstChunkTimeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}
