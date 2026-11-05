/**
 * 工具注册表：白名单 + 参数校验 + 审批开关。
 *
 * 模型只能调用注册过的工具；参数一律用 zod 校验后才执行。
 * 「要不要审批」由工具的 risk 决定，不交给模型自己判断。
 */

import type { RiskLevel } from '@rakko/protocol';
import { z } from 'zod';

import type { ToolCallRequest, ToolDefinition } from './provider.js';

export interface ToolContext {
  /** 所有文件路径都被限制在这个根目录里 */
  workspace: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  risk: RiskLevel;
  /** 高风险工具默认要人点一下 */
  requiresApproval: boolean;
  /** 内置工具用 zod 校验 */
  parameters?: z.ZodType;
  /** 插件工具直接给 JSON Schema，自己校参数 */
  jsonSchema?: unknown;
  run: (args: never, context: ToolContext) => Promise<string>;
}

/**
 * 人点的那一下：允许一次，还是「这类工具以后别再问我」。
 * scope 只在 allow 时有意义；grant 是持久化的，存在用户设置里。
 */
export interface ApprovalOutcome {
  decision: 'allow' | 'deny';
  scope?: 'once' | 'always';
}

export interface ToolResult {
  ok: boolean;
  output: string;
  durationMs: number;
  /** 用户拒绝时置 true：这不是错误，是决定 */
  denied?: boolean;
}

export type ToolInput = Omit<ToolSpec, 'run'>;

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>();
  private readonly context: ToolContext;

  constructor(context: ToolContext) {
    this.context = context;
  }

  register(tool: ToolSpec): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  list(): ToolSpec[] {
    return [...this.tools.values()];
  }

  /** 发给模型的描述：zod 的转成 JSON Schema，插件的原样透传。 */
  definitions(): ToolDefinition[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ? z.toJSONSchema(tool.parameters, { io: 'input' }) : (tool.jsonSchema ?? { type: 'object' }),
    }));
  }

  async execute(
    call: ToolCallRequest,
    options: { approve: () => Promise<ApprovalOutcome>; isGranted?: (name: string) => boolean },
  ): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return { ok: false, output: `没有名为 ${call.name} 的工具。可用工具：${[...this.tools.keys()].join('、')}`, durationMs: 0 };
    }

    // 插件没有 zod，就交给它自己校（run 里抛错会变成工具失败）
    const parsed = tool.parameters ? tool.parameters.safeParse(call.args) : { success: true as const, data: call.args };
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
      return { ok: false, output: `参数不合法：${detail}`, durationMs: 0 };
    }

    if (tool.requiresApproval && !options.isGranted?.(tool.name)) {
      const outcome = await options.approve();
      if (outcome.decision !== 'allow') {
        const why = outcome.decision === 'deny' ? '用户没有允许这次调用' : '审批没有通过';
        return { ok: false, denied: true, output: `${why}，工具未执行。请换一个不需要审批的做法。`, durationMs: 0 };
      }
    }

    const started = Date.now();
    try {
      const output = await tool.run(parsed.data as never, this.context);
      return { ok: true, output, durationMs: Date.now() - started };
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      return { ok: false, output: message, durationMs: Date.now() - started };
    }
  }
}
