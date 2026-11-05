/**
 * 示例工具插件：看最近的提交。
 *
 * 用法：把本文件复制到 ~/.rakko/tools/ 然后重启服务。
 * 插件默认要审批 —— 它跑在你自己的机器上，等价于你写的代码。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const name = 'git_log';
export const description = '看工作区仓库最近几次提交（标题 + 时间）';
export const risk = 'low';
export const requiresApproval = false;
export const parameters = {
  type: 'object',
  properties: {
    count: { type: 'integer', description: '看几次，默认 5，最多 30' },
  },
};

export async function run(args, context) {
  const count = Math.min(30, Math.max(1, Number(args?.count ?? 5)));
  try {
    const { stdout } = await exec('git', ['log', `-${count}`, '--pretty=%h  %ad  %s', '--date=short'], {
      cwd: context.workspace,
    });
    return stdout.trim() || '（还没有提交）';
  } catch (error) {
    return `看不了 git 历史：${error instanceof Error ? error.message : String(error)}`;
  }
}
