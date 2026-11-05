/**
 * 工具插件：让“技能带来新能力”成为可能。
 *
 * 插件就是一个 `.mjs` 文件，放在工具目录里（默认 ~/.rakko/tools），导出：
 *
 *   export const name = 'git_log';
 *   export const description = '看最近几次提交';
 *   export const risk = 'low';              // low | medium | high
 *   export const requiresApproval = false;  // 默认 true
 *   export const parameters = { type: 'object', properties: { ... }, required: [...] };
 *   export async function run(args, context) { return '文本结果'; }
 *
 * 插件跑在服务端进程里，等价于用户自己的代码 —— 所以默认要审批，
 * 而且加载失败只跳过这一个文件，不影响服务启动。
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { RiskLevel } from '@rakko/protocol';

import type { ToolSpec } from './tools.js';

export interface ToolPluginError {
  file: string;
  reason: string;
}

export interface LoadedPlugins {
  tools: ToolSpec[];
  errors: ToolPluginError[];
}

const RISKS: RiskLevel[] = ['low', 'medium', 'high'];

/** 同一毫秒内多次重载也要拿到不同的 URL */
let reloadSeq = 0;

interface PluginModule {
  name?: unknown;
  description?: unknown;
  risk?: unknown;
  requiresApproval?: unknown;
  parameters?: unknown;
  run?: unknown;
}

export async function loadToolPlugins(directory: string): Promise<LoadedPlugins> {
  let entries: string[];
  try {
    entries = (await readdir(directory)).filter((file) => file.endsWith('.mjs') || file.endsWith('.js'));
  } catch {
    // 目录不存在就是没有插件，不算错
    return { tools: [], errors: [] };
  }

  const tools: ToolSpec[] = [];
  const errors: ToolPluginError[] = [];

  for (const file of entries.sort()) {
    const full = path.join(directory, file);
    let module: PluginModule;
    try {
      // ESM 按 URL 缓存；加查询串才能让热重载真的拿到新代码
      const url = pathToFileURL(full).href + `?v=${Date.now().toString(36)}-${reloadSeq++}`;
      module = (await import(url)) as PluginModule;
    } catch (error) {
      errors.push({ file, reason: `加载失败：${error instanceof Error ? error.message : String(error)}` });
      continue;
    }

    const name = typeof module.name === 'string' ? module.name.trim() : '';
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(name)) {
      errors.push({ file, reason: `name 不合法：${String(module.name)}（小写字母开头，允许 a-z0-9_）` });
      continue;
    }
    if (typeof module.run !== 'function') {
      errors.push({ file, reason: '缺 run 函数' });
      continue;
    }
    if (typeof module.description !== 'string' || module.description.trim() === '') {
      errors.push({ file, reason: '缺 description' });
      continue;
    }

    const risk = RISKS.includes(module.risk as RiskLevel) ? (module.risk as RiskLevel) : 'medium';
    const requiresApproval = typeof module.requiresApproval === 'boolean' ? module.requiresApproval : true;
    const parameters =
      module.parameters && typeof module.parameters === 'object'
        ? (module.parameters as Record<string, unknown>)
        : { type: 'object', properties: {} };

    tools.push({
      name,
      description: module.description,
      risk,
      requiresApproval,
      jsonSchema: parameters,
      run: async (args: unknown, context) => {
        // 插件自己校参数；抛错会作为工具失败回给模型
        const result = await (module.run as (input: unknown, ctx: unknown) => Promise<unknown>)(args, context);
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
    });
  }

  return { tools, errors };
}
