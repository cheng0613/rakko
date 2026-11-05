import { validateTree } from '@rakko/genui';

import type { ToolSpec } from '../tools.js';

/**
 * 生成式界面工具。
 *
 * 模型给一份组件树，服务端用白名单校验，不合法的整棵树都拒掉，并把原因回给模型让它重画。
 * 校验在服务端做（客户端还会再验一次），所以「生成式」不等于「模型想画什么就画什么」。
 */
export function createRenderUiTool(): ToolSpec {
  return {
    name: 'render_ui',
    description:
      '把一个回答渲染成结构化界面。可用组件：text/markdown/stack/row/card/list/table/chart/form/button/code/callout。' +
      'button 与 form 的 action 只能是 { send }（发一条消息给我）或 { set }（改本地筛选状态），不能执行任意代码。' +
      '适合：对比表、分步清单、指标卡、可筛选列表、需要我确认的表单。普通一两句话的回答不要用它。',
    risk: 'low',
    requiresApproval: false,
    parameters: undefined,
    jsonSchema: {
      type: 'object',
      properties: {
        tree: {
          type: 'object',
          description: '组件树：{ component, props, children?, bind? }',
        },
      },
      required: ['tree'],
    },
    run: async (args) => {
      const tree = (args as { tree?: unknown }).tree;
      const parsed = validateTree(tree);
      if (!parsed.ok) {
        // 让模型看到具体哪一层错了，它改起来才有方向
        return JSON.stringify({ ok: false, error: parsed.reason });
      }
      return JSON.stringify({ ok: true, tree: parsed.value });
    },
  };
}
