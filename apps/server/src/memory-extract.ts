/**
 * 从一段对话里自动挑出「值得记住」的东西。
 *
 * 用快档模型跑，输出 JSON 数组；解析失败就当没提取到，绝不因为这件事影响主流程。
 * 结果写进 memories 但状态是 pending —— 要用户在记忆页点「采用」才进系统提示。
 */

import { z } from 'zod';

import type { ChatMessage, GatewayChunk, ProviderGateway } from '@rakko/core';
import type { MemoryKind } from '@rakko/protocol';
import { memoryKindSchema } from '@rakko/protocol';

export const extractedMemorySchema = z.object({
  kind: memoryKindSchema,
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(120).optional(),
  body: z.string().trim().min(1).max(600),
});
export type ExtractedMemory = z.infer<typeof extractedMemorySchema>;

const SYSTEM = [
  '你是记忆筛选器。阅读下面这段对话，只挑出「跨会话仍然成立」的信息：',
  '- kind=user：用户的长期偏好、身份、背景',
  '- kind=feedback：用户纠正过你、表达过不满的做法',
  '- kind=project：项目的稳定事实（技术选型、约束、已定决定）',
  '- kind=reference：外部系统、文档、地址',
  '不要记：一次性任务细节、临时状态、能从代码里直接读到的东西、与已有记忆重复的。',
  '最多 3 条；没有就返回空数组。',
  '只输出 JSON 数组，不要解释、不要代码块：',
  '[{"kind":"user","title":"不超过 20 字","description":"不超过 20 字","body":"不超过 200 字"}]',
].join('\n');

const clip = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`;

/** 把对话压成一段纯文本，给筛选器看 */
export function renderConversation(messages: ChatMessage[]): string {
  return messages
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && message.content.trim())
    .slice(-12)
    .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${clip(message.content, 800)}`)
    .join('\n\n');
}

/** 从模型输出里抠出 JSON 数组；坏数据一律当空 */
export function parseExtraction(raw: string): ExtractedMemory[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ExtractedMemory[] = [];
  for (const item of parsed.slice(0, 8)) {
    const result = extractedMemorySchema.safeParse(item);
    if (result.success) out.push(result.data);
  }
  return out;
}

const normalize = (title: string): string => title.toLowerCase().replace(/\s+/g, '');

export interface ExtractOptions {
  gateway: ProviderGateway;
  messages: ChatMessage[];
  /** 已有记忆的标题，用来去重 */
  existingTitles: string[];
  model: string;
  /** 最多挑几条，默认 3 */
  max?: number;
  /** 对话短于这个长度就不值得花一次调用，默认 120 字 */
  minChars?: number;
}

export async function extractMemories(options: ExtractOptions): Promise<ExtractedMemory[]> {
  const conversation = renderConversation(options.messages);
  if (conversation.length < (options.minChars ?? 120)) return [];

  const chunks: GatewayChunk[] = [];
  try {
    for await (const chunk of options.gateway.stream({
      runId: 'memory-extract',
      tier: 'fast',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `已有记忆标题：${options.existingTitles.join('、') || '（无）'}\n\n对话：\n${conversation}` },
      ],
    })) {
      chunks.push(chunk);
    }
  } catch {
    return [];
  }

  const text = chunks.map((chunk) => (chunk.kind === 'delta' ? chunk.text : '')).join('');
  const candidates = parseExtraction(text);

  const seen = new Set(options.existingTitles.map(normalize));
  const kept: ExtractedMemory[] = [];
  for (const candidate of candidates) {
    const key = normalize(candidate.title);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(candidate);
    if (kept.length >= (options.max ?? 3)) break;
  }
  return kept;
}

export type { ChatMessage, MemoryKind };
