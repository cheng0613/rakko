/**
 * Provider 抽象。M0 只有假实现，用来把链路跑通；接真模型时只换这一层。
 * 上层的状态机、配额、熔断都不允许知道具体是哪家模型。
 */

export interface ProviderRequest {
  runId: string;
  prompt: string;
  model: string;
  signal?: AbortSignal;
}

export type ProviderChunk =
  | { kind: 'delta'; text: string }
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

/** 假 provider：吐几句固定文本，给 SSE 与 UI 联调用。 */
export class FakeProvider implements ModelProvider {
  readonly id = 'fake';

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    const lines = [`收到：${request.prompt.slice(0, 40)}`, '先看现状，再动手。', '改完了，跑一遍验证。'];
    for (const line of lines) {
      if (request.signal?.aborted) return;
      yield { kind: 'delta', text: `${line}\n` };
    }
    yield { kind: 'done', finishReason: 'stop' };
  }
}
