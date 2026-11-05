/**
 * Provider 抽象。上层的状态机、配额、熔断都不允许知道具体是哪家模型。
 *
 * 这个网关接的模型大多是「先思考再回答」：先吐 reasoning_content，再吐 content。
 * 所以流里同时有 reasoning 与 delta 两类，别把思考过程当答案存下来。
 */

export interface ProviderRequest {
  runId: string;
  prompt: string;
  model: string;
  signal?: AbortSignal;
}

export type ProviderChunk =
  | { kind: 'delta'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool_call'; callId: string; name: string; args: Record<string, unknown> }
  | { kind: 'done'; finishReason: 'stop' | 'length' | 'tool_use' };

export interface ProviderResult {
  text: string;
  chunks: ProviderChunk[];
}

export interface ModelProvider {
  readonly id: string;
  stream(request: ProviderRequest): AsyncIterable<ProviderChunk>;
}

/** 假 provider：给测试与「没配 key 也能起」用。 */
export class FakeProvider implements ModelProvider {
  readonly id = 'fake';

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    yield { kind: 'reasoning', text: '先看现状，再动手。' };
    const lines = [`收到：${request.prompt.slice(0, 40)}`, '已按计划执行。', '改完了，跑一遍验证。'];
    for (const line of lines) {
      if (request.signal?.aborted) return;
      yield { kind: 'delta', text: `${line}\n` };
    }
    yield { kind: 'done', finishReason: 'stop' };
  }
}
