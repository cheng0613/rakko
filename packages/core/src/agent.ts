/**
 * 一个运行 = 若干轮「模型说 → 工具做 → 结果回给模型」。
 *
 * 这里不碰数据库、不发事件，只负责把轮次跑对：
 *   1. 每轮把完整消息历史发给模型；
 *   2. 有 tool_call 就执行，结果作为 tool 消息塞回去；
 *   3. 没有 tool_call 就收尾；步数超上限直接停，不无限自转。
 */

import type { GatewayChunk, ModelTier, ProviderGateway } from './gateway.js';
import type { ChatMessage, ToolCallRequest } from './provider.js';
import type { ApprovalOutcome, ToolRegistry, ToolResult, ToolSpec } from './tools.js';

export interface AgentHooks {
  /** 流里的增量（回答、思考、降级说明） */
  onChunk: (chunk: GatewayChunk) => Promise<void> | void;
  /** 模型刚提出一个工具调用，还没执行 */
  onToolCall: (call: ToolCallRequest, tool: ToolSpec) => Promise<void> | void;
  onToolResult: (call: ToolCallRequest, result: ToolResult) => Promise<void> | void;
  /** 需要人来点一下；返回 allow 才会执行 */
  approve: (call: ToolCallRequest, tool: ToolSpec) => Promise<ApprovalOutcome>;
  /** 用户以前点过「允许这类」，就不再问 */
  isGranted?: (toolName: string) => boolean;
}

export interface AgentRequest {
  runId: string;
  tier: ModelTier;
  messages: ChatMessage[];
  signal?: AbortSignal;
  /** 本次运行允许的工具（挂载的技能可能收窄它） */
  allowTool?: (name: string) => boolean;
}

export interface AgentOutcome {
  text: string;
  steps: number;
  stopped: 'done' | 'max_steps';
}

export interface AgentLoopOptions {
  maxSteps?: number;
  /** 只允许这些工具（由挂载的技能决定）；不传就是全部 */
  allowTool?: (name: string) => boolean;
}

export class AgentLoop {
  private readonly gateway: ProviderGateway;
  private readonly tools: ToolRegistry;
  private readonly maxSteps: number;
  private readonly allowTool: (name: string) => boolean;

  constructor(gateway: ProviderGateway, tools: ToolRegistry, options: AgentLoopOptions = {}) {
    this.gateway = gateway;
    this.tools = tools;
    this.maxSteps = options.maxSteps ?? 6;
    this.allowTool = options.allowTool ?? (() => true);
  }

  async run(request: AgentRequest, hooks: AgentHooks): Promise<AgentOutcome> {
    const messages: ChatMessage[] = [...request.messages];
    const allow = request.allowTool ?? this.allowTool;
    const definitions = this.tools.definitions().filter((tool) => allow(tool.name));

    let tier = request.tier;
    let text = '';

    for (let step = 1; step <= this.maxSteps; step += 1) {
      let stepText = '';
      const calls: ToolCallRequest[] = [];

      for await (const chunk of this.gateway.stream({
        runId: request.runId,
        tier,
        messages,
        tools: definitions,
        ...(request.signal ? { signal: request.signal } : {}),
      })) {
        if (chunk.kind === 'fallback') {
          // 这一轮已经降到快档了，后面几轮就待在快档，别反复撞主模型
          tier = chunk.to;
        }
        if (chunk.kind === 'delta') stepText += chunk.text;
        if (chunk.kind === 'tool_call') {
          calls.push({ id: chunk.callId, name: chunk.name, args: chunk.args });
        }
        if (chunk.kind !== 'tool_call' && chunk.kind !== 'done') {
          await hooks.onChunk(chunk);
        }
      }

      text += stepText;
      if (calls.length === 0) return { text, steps: step, stopped: 'done' };

      messages.push({ role: 'assistant', content: stepText, toolCalls: calls });

      for (const call of calls) {
        const tool = this.tools.get(call.name);
        if (tool && !allow(call.name)) {
          // 越权也要留痕：先让上层记一条 tool_call，再回一条失败结果
          const blocked = { ok: false, output: `技能没启用 ${call.name}，换一个不越权的做法`, durationMs: 0 };
          await hooks.onToolCall(call, tool);
          await hooks.onToolResult(call, blocked);
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(blocked) });
          continue;
        }
        if (!tool) {
          // 未知工具也要回一条 tool 消息，否则模型会一直等
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: JSON.stringify({ ok: false, output: `没有名为 ${call.name} 的工具` }),
          });
          continue;
        }

        await hooks.onToolCall(call, tool);
        const result = await this.tools.execute(call, {
          approve: () => hooks.approve(call, tool),
          ...(hooks.isGranted ? { isGranted: hooks.isGranted } : {}),
        });
        await hooks.onToolResult(call, result);
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify(result) });
      }
    }

    return { text, steps: this.maxSteps, stopped: 'max_steps' };
  }
}
