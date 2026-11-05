/**
 * 第二个工具包：搜索、改文件、发请求。
 *
 * 纪律跟文件工具一样：路径锁在工作区、参数 zod 校验、输出有上限。
 * 多了两条与网络相关的：默认不许打内网地址（SSRF），
 * 以及一定要过审批 —— 发出去的东西收不回来。
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { ToolSpec } from '../tools.js';

const MAX_MATCHES = 60;
const MAX_LINE = 180;
const MAX_FILE_BYTES = 400_000;
const MAX_HTTP_BODY = 200_000;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.turbo', 'coverage', '.next', '.idea', '.vscode']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.lock', '.map']);

const resolveInside = (workspace: string, candidate: string): string => {
  const root = path.resolve(workspace);
  const target = path.resolve(root, candidate);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`路径越界：${candidate} 解析到 ${target}，不在工作区 ${root} 内`);
  }
  return target;
};

const truncate = (text: string, limit = MAX_LINE): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`;

const globMatches = (filePath: string, glob?: string): boolean => {
  if (!glob) return true;
  const name = path.basename(filePath);
  if (glob.startsWith('*.')) return name.endsWith(glob.slice(1));
  if (glob.includes('*')) {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(name) || new RegExp(escaped).test(filePath.replace(/\\/g, '/'));
  }
  return name === glob || filePath.replace(/\\/g, '/').endsWith(glob);
};

interface WalkHit {
  file: string;
  lines: string[];
}

const walkFiles = async (
  root: string,
  dir: string,
  visit: (file: string) => Promise<boolean | void>,
  depth = 0,
): Promise<void> => {
  if (depth > 8) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkFiles(root, full, visit, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    if (await visit(full)) return;
  }
};

/** 内网 / 环回 / 链路本地：默认一律不许访问 */
const isPrivateHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^127\./.test(host) || /^0\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  return false;
};

export interface HttpToolOptions {
  /** 测试注入 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 明确允许打内网（默认关） */
  allowPrivate?: boolean;
}

export interface SecondToolsetOptions {
  workspace: string;
  http?: HttpToolOptions;
}

export function createSecondToolset(options: SecondToolsetOptions): ToolSpec[] {
  const { workspace } = options;
  const http = options.http ?? {};
  const httpTimeout = http.timeoutMs ?? 20_000;

  return [
    {
      name: 'grep',
      description:
        '在工作区里按正则搜索文件内容，返回「文件:行号: 内容」。会自动跳过 node_modules/.git/dist 与二进制文件。',
      risk: 'low',
      requiresApproval: false,
      parameters: z.object({
        pattern: z.string().min(1).describe('正则表达式，例如 "TODO|FIXME"'),
        path: z.string().describe('相对工作区的目录，默认 "."').optional(),
        glob: z.string().describe('按文件名过滤，例如 "*.ts"').optional(),
        ignoreCase: z.boolean().optional(),
        maxResults: z.number().int().min(1).max(200).optional(),
      }),
      run: async (args: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; maxResults?: number }) => {
        let regex: RegExp;
        try {
          regex = new RegExp(args.pattern, args.ignoreCase ? 'i' : '');
        } catch (error) {
          throw new Error(`正则写错了：${error instanceof Error ? error.message : '无法解析'}`);
        }

        const root = path.resolve(workspace);
        const start = resolveInside(workspace, args.path ?? '.');
        const limit = args.maxResults ?? MAX_MATCHES;
        const hits: WalkHit[] = [];
        let scanned = 0;
        let stopped = false;

        await walkFiles(root, start, async (file) => {
          if (!globMatches(file, args.glob)) return;
          const info = await stat(file);
          if (info.size > MAX_FILE_BYTES) return;
          const buffer = await readFile(file);
          if (buffer.includes(0)) return; // 二进制跳过
          scanned += 1;

          const relative = path.relative(root, file).replace(/\\/g, '/');
          const lines = buffer.toString('utf8').split('\n');
          for (const [index, line] of lines.entries()) {
            regex.lastIndex = 0;
            if (!regex.test(line)) continue;
            hits.push({ file: relative, lines: [`${relative}:${index + 1}: ${truncate(line.trim())}`] });
            if (hits.length >= limit) {
              stopped = true;
              return true;
            }
          }
        });

        if (hits.length === 0) return `没有匹配到 ${args.pattern}（扫了 ${scanned} 个文件）`;
        const body = hits.map((hit) => hit.lines.join('\n')).join('\n');
        return `${body}\n\n（${hits.length} 处匹配${stopped ? '，已到上限' : ''} · 扫了 ${scanned} 个文件）`;
      },
    },
    {
      name: 'apply_patch',
      description:
        '按「原文 → 新文」精确替换来改文件。old 必须在文件里唯一出现；凭空改不了，也改不歧义的地方。需要用户审批。',
      risk: 'high',
      requiresApproval: true,
      parameters: z.object({
        path: z.string().min(1).describe('相对工作区的文件路径'),
        hunks: z
          .array(
            z.object({
              old: z.string().min(1).describe('要被替换的原文片段（必须唯一）'),
              new: z.string().describe('替换成什么，可以是空字符串（等于删除）'),
            }),
          )
          .min(1)
          .max(20),
      }),
      run: async (args: { path: string; hunks: Array<{ old: string; new: string }> }) => {
        const target = resolveInside(workspace, args.path);
        const before = await readFile(target, 'utf8');
        let after = before;
        let added = 0;
        let removed = 0;

        for (const [index, hunk] of args.hunks.entries()) {
          const occurrences = after.split(hunk.old).length - 1;
          if (occurrences === 0) {
            throw new Error(`第 ${index + 1} 处：文件里找不到这段原文。先读一遍文件再改。`);
          }
          if (occurrences > 1) {
            throw new Error(`第 ${index + 1} 处：这段原文出现了 ${occurrences} 次，无法确定改哪一处。请带上更多上下文。`);
          }
          after = after.replace(hunk.old, hunk.new);
          removed += hunk.old.split('\n').length;
          added += hunk.new === '' ? 0 : hunk.new.split('\n').length;
        }

        if (after === before) return `${args.path}：内容没变化，没有写盘`;
        await writeFile(target, after, 'utf8');
        return `${args.path}：${args.hunks.length} 处改动（-${removed} 行 / +${added} 行），已写盘`;
      },
    },
    {
      name: 'http',
      description:
        '发一个 HTTP 请求并返回状态码与响应体（截断 200KB）。默认不许访问内网地址。需要用户审批。',
      risk: 'medium',
      requiresApproval: true,
      parameters: z.object({
        url: z.string().url().describe('http 或 https 地址'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().describe('请求体，字符串；JSON 自己序列化好').optional(),
        timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
      }),
      run: async (args: {
        url: string;
        method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
        headers?: Record<string, string>;
        body?: string;
        timeoutMs?: number;
      }) => {
        const parsed = new URL(args.url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error(`只支持 http/https，收到的是 ${parsed.protocol}`);
        }
        if (!http.allowPrivate && isPrivateHost(parsed.hostname)) {
          throw new Error(`默认不许打内网地址（${parsed.hostname}）；要放开得在服务端打开 RAKKO_HTTP_ALLOW_PRIVATE`);
        }

        const method = args.method ?? 'GET';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? httpTimeout);

        try {
          const response = await (http.fetchImpl ?? fetch)(args.url, {
            method,
            headers: args.headers ?? {},
            ...(args.body && method !== 'GET' ? { body: args.body } : {}),
            signal: controller.signal,
            redirect: 'follow',
          });
          const text = await response.text();
          const body = text.length > MAX_HTTP_BODY ? `${text.slice(0, MAX_HTTP_BODY)}\n…（已截断，原长 ${text.length}）` : text;
          return `${response.status} ${response.statusText}\n${response.headers.get('content-type') ?? ''}\n\n${body}`;
        } catch (error) {
          if (controller.signal.aborted) throw new Error(`请求超时（${args.timeoutMs ?? httpTimeout}ms）`);
          throw error;
        } finally {
          clearTimeout(timer);
        }
      },
    },
  ];
}
