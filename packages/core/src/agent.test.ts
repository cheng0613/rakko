import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AgentLoop } from './agent.js';
import { ProviderGateway } from './gateway.js';
import { ProviderHttpError } from './providers/openai-compatible.js';
import { createBuiltinTools } from './tools/builtin.js';
import { ToolRegistry } from './tools.js';
import type { ChatMessage, ModelProvider, ProviderChunk, ProviderRequest } from './provider.js';

/** 第一次请求工具，拿到 tool 结果后收尾。 */
class LoopProvider implements ModelProvider {
  readonly id = 'loop';
  readonly seen: ChatMessage[][] = [];

  constructor(
    private readonly toolName: string,
    private readonly args: Record<string, unknown>,
    private readonly finalText = '做完了',
    private readonly alwaysAskTool = false,
  ) {}

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    this.seen.push(request.messages);
    const hasToolResult = request.messages.some((message) => message.role === 'tool');

    if (request.tools?.length && (this.alwaysAskTool || !hasToolResult)) {
      yield { kind: 'tool_call', callId: `call_${this.seen.length}`, name: this.toolName, args: this.args };
      yield { kind: 'done', finishReason: 'tool_use' };
      return;
    }

    yield { kind: 'delta', text: this.finalText };
    yield { kind: 'done', finishReason: 'stop' };
  }
}

const setup = async (provider: ModelProvider) => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'rakko-agent-'));
  const registry = new ToolRegistry({ workspace });
  for (const tool of createBuiltinTools({ workspace, shellTimeoutMs: 10_000 })) registry.register(tool);
  const gateway = new ProviderGateway({
    provider,
    models: { standard: 'standard-model', fast: 'fast-model' },
    firstChunkTimeoutMs: 2_000,
  });
  return { workspace, registry, gateway };
};

const baseRequest = { runId: 'run_1', tier: 'standard' as const, messages: [{ role: 'user' as const, content: '看一下文件' }] };

test('低风险工具直接执行，结果回给模型后收尾', async () => {
  const provider = new LoopProvider('list_dir', { path: '.' });
  const { gateway, registry } = await setup(provider);
  const loop = new AgentLoop(gateway, registry);

  const toolCalls: string[] = [];
  const results: string[] = [];
  const outcome = await loop.run(baseRequest, {
    onChunk: () => {},
    onToolCall: (call) => void toolCalls.push(call.name),
    onToolResult: (_call, result) => void results.push(result.ok ? 'ok' : 'fail'),
    approve: () => {
      throw new Error('低风险工具不该弹审批');
    },
  });

  assert.equal(outcome.stopped, 'done');
  assert.equal(outcome.text, '做完了');
  assert.deepEqual(toolCalls, ['list_dir']);
  assert.deepEqual(results, ['ok']);

  // 第二轮发给模型的历史里必须有 assistant.toolCalls 与 tool 结果
  const second = provider.seen[1] ?? [];
  assert.equal(second.at(-1)?.role, 'tool');
  assert.equal(second.at(-2)?.role, 'assistant');
  assert.equal(second.at(-2)?.toolCalls?.[0]?.name, 'list_dir');
});

test('高风险工具被拒：不执行、如实告诉模型、运行照样收尾', async () => {
  const provider = new LoopProvider('write_file', { path: 'note.txt', content: 'x' });
  const { gateway, registry, workspace } = await setup(provider);
  const loop = new AgentLoop(gateway, registry);

  const approaches: string[] = [];
  const results: string[] = [];
  const outcome = await loop.run(baseRequest, {
    onChunk: () => {},
    onToolCall: () => {},
    onToolResult: (_call, result) => void results.push(result.output),
    approve: async () => {
      approaches.push('asked');
      return { decision: 'deny' as const };
    },
  });

  assert.deepEqual(approaches, ['asked']);
  assert.equal(existsSync(path.join(workspace, 'note.txt')), false);
  assert.match(results[0] ?? '', /用户没有允许/);
  assert.equal(outcome.stopped, 'done', '被拒不是失败，模型会换个做法');
});

test('高风险工具被允许：真的写盘', async () => {
  const provider = new LoopProvider('write_file', { path: 'out/note.txt', content: '海獭' });
  const { gateway, registry, workspace } = await setup(provider);
  const loop = new AgentLoop(gateway, registry);

  await loop.run(baseRequest, {
    onChunk: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    approve: async () => ({ decision: 'allow' as const }),
  });

  assert.equal(await readFile(path.join(workspace, 'out/note.txt'), 'utf8'), '海獭');
});

test('模型瞎编工具名，也要回一条结果，别让它干等', async () => {
  const provider = new LoopProvider('delete_everything', {});
  const { gateway, registry } = await setup(provider);
  const loop = new AgentLoop(gateway, registry);

  const outcome = await loop.run(baseRequest, {
    onChunk: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    approve: async () => ({ decision: 'allow' as const }),
  });

  assert.equal(outcome.stopped, 'done');
  const toolMessage = (provider.seen[1] ?? []).at(-1);
  assert.equal(toolMessage?.role, 'tool');
  assert.match(toolMessage?.content ?? '', /没有名为 delete_everything 的工具/);
});

test('模型一直要工具不会无限自转，到上限就停', async () => {
  const provider = new LoopProvider('list_dir', { path: '.' }, '不该到这', true);
  const { gateway, registry } = await setup(provider);
  const loop = new AgentLoop(gateway, registry, { maxSteps: 3 });

  const outcome = await loop.run(baseRequest, {
    onChunk: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    approve: async () => ({ decision: 'allow' as const }),
  });

  assert.equal(outcome.stopped, 'max_steps');
  assert.equal(outcome.steps, 3);
  assert.equal(provider.seen.length, 3);
});

test('主档挂掉降级后，后面几轮待在快档', async () => {
  let standardCalls = 0;
  const provider: ModelProvider = {
    id: 'flaky',
    async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
      if (request.model === 'standard-model') {
        standardCalls += 1;
        throw new ProviderHttpError(503, 'down');
      }
      yield { kind: 'delta', text: `快档答：${request.messages.length} 条历史` };
      yield { kind: 'done', finishReason: 'stop' };
    },
  };

  const { gateway, registry } = await setup(provider);
  const loop = new AgentLoop(gateway, registry);

  const chunks: string[] = [];
  const outcome = await loop.run(baseRequest, {
    onChunk: (chunk) => void chunks.push(chunk.kind),
    onToolCall: () => {},
    onToolResult: () => {},
    approve: async () => ({ decision: 'allow' as const }),
  });

  assert.deepEqual(chunks, ['fallback', 'delta']);
  assert.equal(standardCalls, 1);
  assert.match(outcome.text, /快档答/);
});
