/**
 * 内置工具：读、列、写、跑命令。
 *
 * 三条纪律：
 *   1. 所有路径都被锁在工作区里，`../` 一律拒；
 *   2. 写文件与跑命令必须过审批；
 *   3. 输出有上限，别让一次 `cat` 把上下文撑爆。
 */

import { exec } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { ToolSpec } from '../tools.js';

const MAX_READ_BYTES = 120_000;
const MAX_LIST_ENTRIES = 200;
const MAX_OUTPUT = 8_000;

/** 明显是自毁或提权的命令，连审批都不给。 */
const DENIED_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f?\s+\/(\s|$)/i,
  /\bmkfs(\.|\s)/i,
  /\bdd\s+if=.*of=\/dev\//i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bchown\s+-R\s+.*\s+\/$/i,
  /:\s*\(\s*\)\s*\{/,
];

const resolveInside = (workspace: string, candidate: string): string => {
  const root = path.resolve(workspace);
  const target = path.resolve(root, candidate);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`路径越界：${candidate} 解析到 ${target}，不在工作区 ${root} 内`);
  }
  return target;
};

const truncate = (text: string, limit = MAX_OUTPUT): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}\n…（已截断，原长 ${text.length} 字符）`;

const runShell = (command: string, cwd: string, timeoutMs: number): Promise<string> =>
  new Promise((resolve, reject) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      if (error && 'killed' in error && error.killed) {
        reject(new Error(`命令超时（${timeoutMs}ms）已终止`));
        return;
      }
      if (error) {
        reject(new Error(`命令退出码 ${error.code ?? '未知'}\n${truncate(output)}`));
        return;
      }
      resolve(output || '（命令执行成功，没有输出）');
    });
  });

export interface BuiltinToolsOptions {
  workspace: string;
  /** 单条命令的默认超时 */
  shellTimeoutMs?: number;
}

export function createBuiltinTools(options: BuiltinToolsOptions): ToolSpec[] {
  const { workspace } = options;
  const shellTimeoutMs = options.shellTimeoutMs ?? 20_000;

  return [
    {
      name: 'read_file',
      description: '读取工作区里一个文本文件的内容。路径必须是相对工作区的路径。',
      risk: 'low',
      requiresApproval: false,
      parameters: z.object({
        path: z.string().min(1).describe('相对工作区的文件路径，例如 packages/core/src/index.ts'),
      }),
      run: async (args: { path: string }) => {
        const target = resolveInside(workspace, args.path);
        const buffer = await readFile(target);
        if (buffer.byteLength > MAX_READ_BYTES) {
          return `${buffer.subarray(0, MAX_READ_BYTES).toString('utf8')}\n…（文件较大，只读了前 ${MAX_READ_BYTES} 字节）`;
        }
        const text = buffer.toString('utf8');
        return text.length > 0 ? text : '（空文件）';
      },
    },
    {
      name: 'list_dir',
      description: '列出工作区里某个目录的条目。目录名以 / 结尾。',
      risk: 'low',
      requiresApproval: false,
      parameters: z.object({
        path: z.string().describe('相对工作区的目录路径，默认 "." 表示工作区根目录').optional(),
      }),
      run: async (args: { path?: string }) => {
        const target = resolveInside(workspace, args.path ?? '.');
        const entries = await readdir(target, { withFileTypes: true });
        const lines = entries
          .slice(0, MAX_LIST_ENTRIES)
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
          .sort();
        const suffix = entries.length > MAX_LIST_ENTRIES ? `\n…（共 ${entries.length} 项，只列了前 ${MAX_LIST_ENTRIES} 项）` : '';
        return lines.length > 0 ? `${lines.join('\n')}${suffix}` : '（空目录）';
      },
    },
    {
      name: 'write_file',
      description: '把一个文件写进工作区，会覆盖同名文件。需要用户审批。',
      risk: 'high',
      requiresApproval: true,
      parameters: z.object({
        path: z.string().min(1).describe('相对工作区的文件路径'),
        content: z.string().describe('要写入的完整内容'),
      }),
      run: async (args: { path: string; content: string }) => {
        const target = resolveInside(workspace, args.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, args.content, 'utf8');
        return `已写入 ${args.path}（${Buffer.byteLength(args.content, 'utf8')} 字节）`;
      },
    },
    {
      name: 'shell',
      description: '在工作区里执行一条 shell 命令。需要用户审批。',
      risk: 'high',
      requiresApproval: true,
      parameters: z.object({
        command: z.string().min(1).describe('要执行的命令，例如 pnpm typecheck'),
        timeoutMs: z.number().int().min(1_000).max(300_000).optional().describe('超时毫秒数，默认 20000'),
      }),
      run: async (args: { command: string; timeoutMs?: number }) => {
        const denied = DENIED_PATTERNS.find((pattern) => pattern.test(args.command));
        if (denied) throw new Error(`这条命令被硬规则拦下：${args.command}`);
        return runShell(args.command, path.resolve(workspace), args.timeoutMs ?? shellTimeoutMs);
      },
    },
  ];
}
