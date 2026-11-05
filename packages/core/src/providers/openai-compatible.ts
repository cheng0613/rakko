/**
 * OpenAI 兼容的流式 provider。
 *
 * 只做一件事：把 /chat/completions 的 SSE 变成 ProviderChunk。
 * 重试、降级、熔断都不在这里 —— 那是 ProviderGateway 的活。
 */

import type { ChatMessage, ModelProvider, ProviderChunk, ProviderRequest } from '../provider.js';

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  /** 整次请求的总超时 */
  timeoutMs?: number;
  /** 附加请求体，例如 temperature；默认什么都不加 */
  extraBody?: Record<string, unknown>;
  /** 测试注入 */
  fetchImpl?: typeof fetch;
}

/** 4xx 里只有 408/429 值得重试，5xx 一律算上游问题。 */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`模型接口返回 ${status}`);
    this.name = 'ProviderHttpError';
  }

  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export class ProviderTimeoutError extends Error {
  constructor(message = '模型响应超时') {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}

interface ChatDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface ChatChunk {
  choices?: Array<{ delta?: ChatDelta; finish_reason?: string | null }>;
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

const mapFinish = (reason: string | null | undefined): 'stop' | 'length' | 'tool_use' => {
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  return 'stop';
};

/** 本地消息 → 接口消息。assistant 的工具请求要还原成 tool_calls。 */
const toWireMessages = (messages: ChatMessage[]): unknown[] =>
  messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId ?? '', content: message.content };
    }
    if (message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });

const toWireTools = (tools: ProviderRequest['tools']): unknown[] | undefined =>
  tools?.length
    ? tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }))
    : undefined;

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = 'openai-compatible';
  private readonly options: OpenAICompatibleOptions;

  constructor(options: OpenAICompatibleOptions) {
    this.options = options;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    const controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    const timer = setTimeout(() => controller.abort(new ProviderTimeoutError()), timeoutMs);

    const forwardAbort = (): void => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', forwardAbort, { once: true });

    try {
      const doFetch = this.options.fetchImpl ?? fetch;
      const response = await doFetch(`${trimSlash(this.options.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          stream: true,
          messages: toWireMessages(request.messages),
          ...(request.tools?.length ? { tools: toWireTools(request.tools), tool_choice: 'auto' } : {}),
          ...this.options.extraBody,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new ProviderHttpError(response.status, body.slice(0, 500));
      }
      if (!response.body) throw new Error('模型接口没有返回流');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finishReason: 'stop' | 'length' | 'tool_use' = 'stop';

      /** tool call 的 arguments 是分片来的，攒齐了再发。 */
      const toolCalls = new Map<number, { id: string; name: string; args: string }>();

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          const line = part.split('\n').find((candidate) => candidate.startsWith('data:'));
          if (!line) continue;

          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            for (const call of this.completeToolCalls(toolCalls)) yield call;
            yield { kind: 'done', finishReason };
            return;
          }

          let chunk: ChatChunk;
          try {
            chunk = JSON.parse(payload) as ChatChunk;
          } catch {
            continue; // 坏行只丢这一行，不打断整条流
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;
          finishReason = mapFinish(choice.finish_reason) ?? finishReason;

          const delta = choice.delta;
          if (!delta) continue;

          // 思考过程单独一类：只用于展示「正在想」，绝不能拼进回答
          if (delta.reasoning_content) {
            yield { kind: 'reasoning', text: delta.reasoning_content };
          }
          if (delta.content) {
            yield { kind: 'delta', text: delta.content };
          }
          for (const call of delta.tool_calls ?? []) {
            const index = call.index ?? 0;
            const current = toolCalls.get(index) ?? { id: call.id ?? `call_${index}`, name: '', args: '' };
            toolCalls.set(index, {
              id: call.id ?? current.id,
              name: call.function?.name ?? current.name,
              args: current.args + (call.function?.arguments ?? ''),
            });
          }
        }
      }

      for (const call of this.completeToolCalls(toolCalls)) yield call;
      yield { kind: 'done', finishReason };
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof Error) {
        throw controller.signal.reason;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private *completeToolCalls(
    calls: Map<number, { id: string; name: string; args: string }>,
  ): Iterable<ProviderChunk> {
    for (const call of calls.values()) {
      if (!call.name) continue;
      let args: Record<string, unknown> = {};
      try {
        args = call.args ? (JSON.parse(call.args) as Record<string, unknown>) : {};
      } catch {
        args = { _raw: call.args };
      }
      yield { kind: 'tool_call', callId: call.id, name: call.name, args };
    }
  }
}
