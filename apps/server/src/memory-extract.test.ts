import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ProviderGateway } from '@rakko/core';
import type { ModelProvider, ProviderChunk, ProviderRequest } from '@rakko/core';

import { extractMemories, parseExtraction, renderConversation } from './memory-extract.js';

/** 固定返回一段文本的假 provider */
const replying = (text: string): ModelProvider => ({
  id: 'reply',
  async *stream(): AsyncIterable<ProviderChunk> {
    yield { kind: 'delta', text };
    yield { kind: 'done', finishReason: 'stop' };
  },
});

const conversation = [
  { role: 'user' as const, content: '以后回答先给结论，别写「好的我来帮你」。' },
  { role: 'assistant' as const, content: '明白。' },
  { role: 'user' as const, content: '这项目用 Postgres 做唯一事实源，不搞本地缓存。' },
];

test('parseExtraction 只接受合法条目，坏数据丢掉', () => {
  const good = parseExtraction(JSON.stringify([
    { kind: 'user', title: '先给结论', body: '不喜欢客套。' },
    { kind: 'project', title: 'Postgres 独占', description: '架构约束', body: '不做本地缓存。' },
    { kind: 'nope', title: '非法 kind', body: 'x' },
    { kind: 'user', title: '', body: '空标题' },
  ]));
  assert.equal(good.length, 2);
  assert.equal(good[0]?.kind, 'user');
  assert.equal(good[1]?.description, '架构约束');
});

test('模型把 JSON 包在解释文字里也能抠出来', () => {
  const raw = '好的，这是结果：\n[{"kind":"feedback","title":"别用玩笑语气","body":"工作场景严肃一点"}]\n以上。';
  const parsed = parseExtraction(raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.title, '别用玩笑语气');
});

test('完全不是 JSON 时返回空数组，不抛错', () => {
  assert.deepEqual(parseExtraction('我觉得这段对话没啥可记的'), []);
  assert.deepEqual(parseExtraction('[{"kind":'), []);
  assert.deepEqual(parseExtraction(''), []);
});

test('renderConversation 只留用户与助手的文本，并截断', () => {
  const text = renderConversation([
    { role: 'system', content: '系统提示不该出现' },
    { role: 'user', content: 'x'.repeat(2000) },
    { role: 'assistant', content: '收到' },
  ]);
  assert.doesNotMatch(text, /系统提示/);
  assert.match(text, /^用户：x/);
  assert.match(text, /助手：收到/);
  assert.ok(text.length < 1100, '长内容要被截断');
});

test('extractMemories 会按已有标题去重，并且最多留 3 条', async () => {
  const provider = replying(
    JSON.stringify([
      { kind: 'user', title: '先给结论', body: '不喜欢客套。' },
      { kind: 'user', title: ' 先给结论 ', body: '重复的，应被去掉' },
      { kind: 'project', title: 'Postgres 独占', body: '不做本地缓存。' },
      { kind: 'reference', title: '设计稿位置', body: 'design.html 在 opendesign 目录。' },
      { kind: 'user', title: '第四条', body: '超过上限应被截掉。' },
    ]),
  );

  const gateway = new ProviderGateway({ provider, models: { standard: 's', fast: 'f' } });
  const result = await extractMemories({
    gateway,
    messages: conversation,
    existingTitles: ['设计稿位置'],
    model: 'f',
    minChars: 0,
  });

  const titles = result.map((item) => item.title);
  // 5 条候选：重复标题去掉一条，命中已有记忆去掉一条，剩下 3 条（正好到上限）
  assert.equal(result.length, 3);
  assert.deepEqual(titles, ['先给结论', 'Postgres 独占', '第四条']);
});

test('对话太短就不提取（省一次模型调用）', async () => {
  let called = 0;
  const provider: ModelProvider = {
    id: 'count',
    async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
      called += 1;
      yield { kind: 'delta', text: '[]' };
      yield { kind: 'done', finishReason: 'stop' };
    },
  };

  const gateway = new ProviderGateway({ provider, models: { standard: 's', fast: 'f' } });
  const result = await extractMemories({
    gateway,
    messages: [{ role: 'user', content: '嗯' }],
    existingTitles: [],
    model: 'f',
  });

  assert.deepEqual(result, []);
  assert.equal(called, 0, '太短就该直接跳过，不花这次调用');
});

test('模型报错时返回空数组，不影响调用方', async () => {
  const provider: ModelProvider = {
    id: 'boom',
    async *stream(): AsyncIterable<ProviderChunk> {
      throw new Error('上游挂了');
    },
  };
  const gateway = new ProviderGateway({ provider, models: { standard: 's', fast: 'f' } });
  const result = await extractMemories({ gateway, messages: conversation, existingTitles: [], model: 'f' });
  assert.deepEqual(result, []);
});
