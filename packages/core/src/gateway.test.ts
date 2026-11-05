import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CircuitBreaker } from './circuit-breaker.js';
import { ProviderGateway, ProviderUnavailable } from './gateway.js';
import { ProviderHttpError } from './providers/openai-compatible.js';
import type { ModelProvider, ProviderChunk, ProviderRequest } from './provider.js';

/** 可编排的 provider：按 model 决定吐什么、什么时候失败。 */
class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted';
  readonly calls: string[] = [];

  constructor(
    private readonly script: Record<string, (request: ProviderRequest) => AsyncIterable<ProviderChunk>>,
  ) {}

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    this.calls.push(request.model);
    const handler = this.script[request.model];
    if (!handler) throw new ProviderHttpError(404, 'model not found');
    yield* handler(request);
  }
}

const ok = (text: string) =>
  async function* (): AsyncIterable<ProviderChunk> {
    yield { kind: 'delta', text };
    yield { kind: 'done', finishReason: 'stop' };
  };

const boom = (status = 503) =>
  async function* (): AsyncIterable<ProviderChunk> {
    throw new ProviderHttpError(status, 'upstream down');
    // eslint-disable-next-line no-unreachable
    yield { kind: 'done', finishReason: 'stop' };
  };

const models = { standard: 'slow-pro', fast: 'quick-flash' };

const collectKinds = async (gateway: ProviderGateway, tier: 'standard' | 'fast' = 'standard'): Promise<string[]> => {
  const kinds: string[] = [];
  for await (const chunk of gateway.stream({ runId: 'r1', messages: [{ role: 'user', content: '跑一下' }], tier })) kinds.push(chunk.kind);
  return kinds;
};

test('主模型直接成功时，不碰快模型', async () => {
  const provider = new ScriptedProvider({ 'slow-pro': ok('好的') });
  const gateway = new ProviderGateway({ provider, models });

  const kinds = await collectKinds(gateway);
  assert.deepEqual(kinds, ['delta', 'done']);
  assert.deepEqual(provider.calls, ['slow-pro']);
});

test('主模型还没吐字就挂了 → 降级到快模型，并明确告知原因', async () => {
  const provider = new ScriptedProvider({ 'slow-pro': boom(), 'quick-flash': ok('快模型接住了') });
  const gateway = new ProviderGateway({ provider, models });

  const chunks = [];
  for await (const chunk of gateway.stream({ runId: 'r1', messages: [{ role: 'user', content: '跑一下' }], tier: 'standard' })) chunks.push(chunk);

  assert.deepEqual(
    chunks.map((chunk) => chunk.kind),
    ['fallback', 'delta', 'done'],
  );
  const fallback = chunks[0];
  assert.ok(fallback && fallback.kind === 'fallback');
  if (fallback?.kind === 'fallback') {
    assert.equal(fallback.from, 'standard');
    assert.equal(fallback.to, 'fast');
    assert.match(fallback.reason, /quick-flash/);
    assert.match(fallback.reason, /503/);
  }
  assert.deepEqual(provider.calls, ['slow-pro', 'quick-flash']);
});

test('已经吐出内容再挂，不换模型（否则回答会重复），直接失败', async () => {
  const provider = new ScriptedProvider({
    'slow-pro': async function* () {
      yield { kind: 'delta', text: '前半段' };
      throw new ProviderHttpError(500, '断了');
    },
    'quick-flash': ok('不该被调用'),
  });
  const gateway = new ProviderGateway({ provider, models });

  await assert.rejects(
    async () => {
      for await (const _chunk of gateway.stream({ runId: 'r1', messages: [{ role: 'user', content: '跑一下' }], tier: 'standard' })) {
        // 收到前半段
      }
    },
    (error: unknown) => {
      assert.ok(error instanceof ProviderUnavailable);
      assert.match(error.message, /中途失败/);
      return true;
    },
  );
  assert.deepEqual(provider.calls, ['slow-pro']);
});

test('主模型连续失败到阈值后熔断，后续直接走快模型', async () => {
  const provider = new ScriptedProvider({ 'slow-pro': boom(), 'quick-flash': ok('快') });
  const standard = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000 });
  const gateway = new ProviderGateway({ provider, models, breakers: { standard } });

  await collectKinds(gateway);
  await collectKinds(gateway);
  assert.equal(gateway.breakerState('standard'), 'open');

  const callsBefore = provider.calls.length;
  const kinds = await collectKinds(gateway);
  assert.deepEqual(kinds, ['fallback', 'delta', 'done']);
  assert.equal(provider.calls.length, callsBefore + 1, '第三次不该再打主模型');
  assert.equal(provider.calls.at(-1), 'quick-flash');
});

test('两档都挂 → ProviderUnavailable，错误里带上最后原因', async () => {
  const provider = new ScriptedProvider({});
  const gateway = new ProviderGateway({ provider, models });

  await assert.rejects(() => collectKinds(gateway), (error: unknown) => {
    assert.ok(error instanceof ProviderUnavailable);
    assert.match(error.message, /快模型也没接上/);
    return true;
  });
});

test('首字超时也算故障，会立刻降级而不是干等', async () => {
  const provider = new ScriptedProvider({
    'slow-pro': async function* () {
      await new Promise((resolve) => setTimeout(resolve, 80));
      yield { kind: 'delta', text: '太晚了' };
    },
    'quick-flash': ok('快'),
  });
  const gateway = new ProviderGateway({ provider, models, firstChunkTimeoutMs: 20 });

  const chunks = [];
  for await (const chunk of gateway.stream({ runId: 'r1', messages: [{ role: 'user', content: '跑一下' }], tier: 'standard' })) chunks.push(chunk);

  assert.equal(chunks[0]?.kind, 'fallback');
  const fallback = chunks[0];
  if (fallback?.kind === 'fallback') assert.match(fallback.reason, /首字超时/);
});

test('配额已经降级时直接从快模型起跑，不先撞主模型', async () => {
  const provider = new ScriptedProvider({ 'quick-flash': ok('快') });
  const gateway = new ProviderGateway({ provider, models });

  const kinds = await collectKinds(gateway, 'fast');
  assert.deepEqual(kinds, ['delta', 'done']);
  assert.deepEqual(provider.calls, ['quick-flash']);
});
