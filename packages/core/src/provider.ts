/**
 * Provider 抽象。上层的状态机、配额、熔断都不允许知道具体是哪家模型。
 *
 * 这些模型是「先思考再回答」的：先吐 reasoning_content，再吐 content。
 * 所以流里同时有 reasoning 与 delta 两类，别把思考过程当答案存下来。
 */

export interface ToolCallRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** 发给模型的对话历史。tool 消息必须带 toolCallId，否则模型对不上号。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCallRequest[];
  toolCallId?: string;
  name?: string;
}

/** 工具的模型侧描述：JSON Schema 由 zod 转出来，不手写。 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ProviderRequest {
  runId: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}

export type ProviderChunk =
  | { kind: 'delta'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool_call'; callId: string; name: string; args: Record<string, unknown> }
  | { kind: 'done'; finishReason: 'stop' | 'length' | 'tool_use' };

export interface ModelProvider {
  readonly id: string;
  stream(request: ProviderRequest): AsyncIterable<ProviderChunk>;
}

/**
 * 假 provider：没配 key 也能把整条链路跑通，包括工具调用。
 * 给了工具时先请求一次工具调用，拿到 tool 结果后再给总结。
 */
export class FakeProvider implements ModelProvider {
  readonly id = 'fake';

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    yield { kind: 'reasoning', text: '先看现状，再动手。' };

    const hasToolResult = request.messages.some((message) => message.role === 'tool');
    const tools = request.tools ?? [];

    if (tools.length > 0 && !hasToolResult) {
      const first = tools[0];
      if (first) {
        yield { kind: 'delta', text: '先读一下工作区的说明文件。\n' };
        yield { kind: 'tool_call', callId: `call_fake_${Date.now()}`, name: first.name, args: { path: 'README.md' } };
        yield { kind: 'done', finishReason: 'tool_use' };
        return;
      }
    }

    const lastTool = [...request.messages].reverse().find((message) => message.role === 'tool');
    if (lastTool) {
      yield { kind: 'delta', text: '工具结果拿到了，总结一下：这条链路是通的。\n' };
      yield { kind: 'done', finishReason: 'stop' };
      return;
    }

    const prompt = request.messages.at(-1)?.content ?? '';
    yield { kind: 'delta', text: `收到：${prompt.slice(0, 40)}\n` };
    yield { kind: 'delta', text: '已按计划执行。\n' };
    yield { kind: 'done', finishReason: 'stop' };
  }
}
