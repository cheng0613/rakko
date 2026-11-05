import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cosineSimilarity, OpenAICompatibleEmbeddings, toVectorLiteral } from './embedding.js';

const mockFetch = (payload: unknown, status = 200): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

test('embedding 按 index 顺序返回，并校验维度', async () => {
  const provider = new OpenAICompatibleEmbeddings({
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    model: 'emb',
    dims: 3,
    fetchImpl: mockFetch({
      data: [
        { index: 1, embedding: [0, 1, 0] },
        { index: 0, embedding: [1, 0, 0] },
      ],
    }),
  });

  const vectors = await provider.embed(['first', 'second']);
  assert.deepEqual(vectors[0], [1, 0, 0]);
  assert.deepEqual(vectors[1], [0, 1, 0]);
});

test('维度对不上就抛错，让调用方退回关键词', async () => {
  const provider = new OpenAICompatibleEmbeddings({
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    model: 'emb',
    dims: 4,
    fetchImpl: mockFetch({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
  });

  await assert.rejects(() => provider.embed(['x']), /维度不对/);
});

test('接口非 2xx 抛错', async () => {
  const provider = new OpenAICompatibleEmbeddings({
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    model: 'emb',
    dims: 3,
    fetchImpl: mockFetch({ error: 'nope' }, 401),
  });
  await assert.rejects(() => provider.embed(['x']), /401/);
});

test('空输入不发请求', async () => {
  let called = 0;
  const provider = new OpenAICompatibleEmbeddings({
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    model: 'emb',
    dims: 3,
    fetchImpl: (async () => {
      called += 1;
      return new Response('{}');
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(await provider.embed([]), []);
  assert.equal(called, 0);
});

test('余弦相似度：同向为 1，正交为 0，长度不一致为 0', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.ok(Math.abs(cosineSimilarity([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-9);
});

test('向量字面量格式对得上 pgvector', () => {
  assert.equal(toVectorLiteral([0.1, 0.2]), '[0.1,0.2]');
  assert.equal(toVectorLiteral([1.23456789]), '[1.234568]');
});
