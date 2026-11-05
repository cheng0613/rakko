import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OpenAICompatibleProvider, ProviderHttpError, ProviderTimeoutError } from './openai-compatible.js';
import type { ProviderChunk } from '../provider.js';

const sseStream = (rows: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const row of rows) controller.enqueue(encoder.encode(row));
      controller.close();
    },
  });
};

const mockFetch = (rows: string[], init: { status?: number; body?: string } = {}): typeof fetch =>
  (async () =>
    new Response(init.status && init.status !== 200 ? (init.body ?? 'boom') : sseStream(rows), {
      status: init.status ?? 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as unknown as typeof fetch;

const collect = async (provider: OpenAICompatibleProvider, prompt = '看看构建'): Promise<ProviderChunk[]> => {
  const chunks: ProviderChunk[] = [];
  for await (const chunk of provider.stream({ runId: 'r1', messages: [{ role: 'user', content: prompt }], model: 'deepseek-v4-pro' })) chunks.push(chunk);
  return chunks;
};

const line = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const reasoning = (text: string) => line({ choices: [{ index: 0, delta: { reasoning_content: text } }] });
const content = (text: string) => line({ choices: [{ index: 0, delta: { content: text } }] });

test('思考过程与回答分开流出来，最后以 done 收尾', async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    fetchImpl: mockFetch([
      reasoning('先看现状'),
      reasoning('再动手'),
      content('改完了。'),
      line({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ]),
  });

  const chunks = await collect(provider);
  assert.deepEqual(
    chunks.map((chunk) => chunk.kind),
    ['reasoning', 'reasoning', 'delta', 'done'],
  );
  assert.deepEqual(
    chunks.filter((chunk) => chunk.kind === 'reasoning').map((chunk) => (chunk.kind === 'reasoning' ? chunk.text : '')),
    ['先看现状', '再动手'],
  );
  assert.equal(chunks.at(-1)?.kind === 'done' ? (chunks.at(-1) as { finishReason: string }).finishReason : null, 'stop');
});

test('请求带对了地址、鉴权与流式开关', async () => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'https://example.test/v1/',
    apiKey: 'secret-key',
    fetchImpl: (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return new Response(sseStream(['data: [DONE]\n\n']), { status: 200 });
    }) as unknown as typeof fetch,
  });

  await collect(provider, '你好');
  assert.equal(seenUrl, 'https://example.test/v1/chat/completions');
  assert.equal((seenInit?.headers as Record<string, string>)['authorization'], 'Bearer secret-key');
  const body = JSON.parse(String(seenInit?.body)) as { model: string; stream: boolean; messages: unknown[] };
  assert.equal(body.model, 'deepseek-v4-pro');
  assert.equal(body.stream, true);
  assert.equal(body.messages.length, 1);
});

test('非 2xx 抛 ProviderHttpError，并区分是否值得重试', async () => {
  const unauthorized = new OpenAICompatibleProvider({
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    fetchImpl: mockFetch([], { status: 401, body: 'invalid api key' }),
  });
  await assert.rejects(() => collect(unauthorized), (error: unknown) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.status, 401);
    assert.equal(error.retryable, false);
    return true;
  });

  const down = new OpenAICompatibleProvider({
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    fetchImpl: mockFetch([], { status: 503, body: 'overloaded' }),
  });
  await assert.rejects(() => collect(down), (error: unknown) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.retryable, true);
    return true;
  });
});

test('坏行只丢这一行，不打断整条流', async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    fetchImpl: mockFetch(['data: {oops\n\n', content('还能继续'), 'data: [DONE]\n\n']),
  });
  const chunks = await collect(provider);
  assert.equal(chunks[0]?.kind, 'delta');
});

test('超时会以 ProviderTimeoutError 结束，而不是一直挂着', async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    timeoutMs: 30,
    fetchImpl: (async (_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as unknown as typeof fetch,
  });

  await assert.rejects(() => collect(provider), (error: unknown) => {
    assert.ok(error instanceof ProviderTimeoutError || (error as Error).name === 'AbortError');
    return true;
  });
});
