/**
 * 存储接口 —— 服务端只认这个接口，不认具体实现。
 *
 * MemoryStore 给测试和「没配 DATABASE_URL 时也能起」用；
 * PostgresStore 是 M0 之后的事实源实现。两者行为必须一致，否则测试就没意义了。
 */

import { randomUUID } from 'node:crypto';

import { currentPeriod, decideQuota, periodStart, planLimit, type QuotaDecision, type QuotaState } from '@rakko/core';
import type { Message, MessageKind, MessageRole, Run, RunEvent, Thread, Usage } from '@rakko/protocol';

export interface AppendMessageInput {
  threadId: string;
  role: MessageRole;
  text: string;
  /** 默认 text；工具调用与审批也走同一张表，重会话才能重放 */
  kind?: MessageKind;
  payload?: Record<string, unknown> | null;
  runId?: string | null;
}

export interface CreateRunInput {
  threadId: string;
  prompt: string;
  model: string;
}

export type RunPatch = Partial<Pick<Run, 'state' | 'error' | 'finishedAt' | 'model'>>;

export type Listener = (event: RunEvent) => void;

export interface RunStore {
  /** 供 /health 区分实现，运维一眼能看出接的哪个 */
  readonly kind: 'memory' | 'postgres';
  /** 建连接、迁移、准备默认用户 */
  ready(): Promise<void>;
  /** 进程重启后，把停在半路的运行标成失败（否则会永远挂在 waiting_approval） */
  recoverOrphans(): Promise<number>;
  listThreads(): Promise<Thread[]>;
  getThread(id: string): Promise<Thread | undefined>;
  createThread(title?: string): Promise<Thread>;
  listMessages(threadId: string): Promise<Message[]>;
  appendMessage(input: AppendMessageInput): Promise<Message>;
  createRun(input: CreateRunInput): Promise<Run>;
  getRun(id: string): Promise<Run | undefined>;
  patchRun(id: string, patch: RunPatch): Promise<Run | undefined>;
  /** SSE 重放用，按 seq 升序 */
  eventsOf(runId: string): Promise<RunEvent[]>;
  /** 落库 + 推给订阅者。顺序不能反。 */
  publish(event: RunEvent): Promise<void>;
  subscribe(runId: string, listener: Listener): () => void;
  quotaDecision(): Promise<QuotaDecision>;
  chargeRun(run: Run): Promise<void>;
  usage(): Promise<Usage>;
  close(): Promise<void>;
}

const now = (): string => new Date().toISOString();

export interface MemoryStoreOptions {
  limit?: number;
  used?: number;
  degradeOnExceed?: boolean;
}

/** 进程内实现：形状与 Postgres 版一致，进程重启即清空。 */
export class MemoryStore implements RunStore {
  readonly kind = 'memory' as const;
  private quota: QuotaState;

  constructor(options: MemoryStoreOptions = {}) {
    this.quota = {
      limit: options.limit ?? planLimit('pro'),
      used: options.used ?? 0,
      degradeOnExceed: options.degradeOnExceed ?? true,
    };
  }
  private readonly threads = new Map<string, Thread>();
  private readonly runs = new Map<string, Run>();
  private readonly messages = new Map<string, Message[]>();
  private readonly events = new Map<string, RunEvent[]>();
  private readonly listeners = new Map<string, Set<Listener>>();

  async ready(): Promise<void> {}

  async close(): Promise<void> {}

  async recoverOrphans(): Promise<number> {
    return 0;
  }

  async listThreads(): Promise<Thread[]> {
    return [...this.threads.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getThread(id: string): Promise<Thread | undefined> {
    return this.threads.get(id);
  }

  async createThread(title?: string): Promise<Thread> {
    const at = now();
    const thread: Thread = { id: randomUUID(), title: title ?? '新对话', createdAt: at, updatedAt: at };
    this.threads.set(thread.id, thread);
    this.messages.set(thread.id, []);
    return thread;
  }

  async listMessages(threadId: string): Promise<Message[]> {
    return this.messages.get(threadId) ?? [];
  }

  async appendMessage(input: AppendMessageInput): Promise<Message> {
    const message: Message = {
      id: randomUUID(),
      threadId: input.threadId,
      role: input.role,
      kind: input.kind ?? 'text',
      text: input.text,
      payload: input.payload ?? null,
      runId: input.runId ?? null,
      createdAt: now(),
    };
    const list = this.messages.get(input.threadId) ?? [];
    list.push(message);
    this.messages.set(input.threadId, list);

    const thread = this.threads.get(input.threadId);
    if (thread) this.threads.set(thread.id, { ...thread, updatedAt: message.createdAt });

    return message;
  }

  async createRun(input: CreateRunInput): Promise<Run> {
    const run: Run = {
      id: randomUUID(),
      threadId: input.threadId,
      state: 'queued',
      model: input.model,
      prompt: input.prompt,
      error: null,
      createdAt: now(),
      finishedAt: null,
    };
    this.runs.set(run.id, run);
    this.events.set(run.id, []);
    return run;
  }

  async getRun(id: string): Promise<Run | undefined> {
    return this.runs.get(id);
  }

  async patchRun(id: string, patch: RunPatch): Promise<Run | undefined> {
    const run = this.runs.get(id);
    if (!run) return undefined;
    const next: Run = { ...run, ...patch };
    this.runs.set(id, next);
    return next;
  }

  async eventsOf(runId: string): Promise<RunEvent[]> {
    return this.events.get(runId) ?? [];
  }

  async publish(event: RunEvent): Promise<void> {
    const list = this.events.get(event.runId) ?? [];
    list.push(event);
    this.events.set(event.runId, list);
    for (const listener of this.listeners.get(event.runId) ?? []) listener(event);
  }

  subscribe(runId: string, listener: Listener): () => void {
    const set = this.listeners.get(runId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
    };
  }

  async quotaDecision(): Promise<QuotaDecision> {
    return decideQuota(this.quota);
  }

  async chargeRun(): Promise<void> {
    this.quota.used += 1;
  }

  async usage(): Promise<Usage> {
    return {
      plan: 'Pro',
      limit: this.quota.limit,
      used: this.quota.used,
      remaining: Math.max(0, this.quota.limit - this.quota.used),
      periodStart: periodStart(),
      degradeOnExceed: this.quota.degradeOnExceed,
    };
  }

  /** 测试用：把用量推到上限，验证降级分支。 */
  setUsage(used: number): void {
    this.quota = { ...this.quota, used };
  }

  /** 测试用：当前周期，和 Postgres 版对账。 */
  period(): string {
    return currentPeriod();
  }
}
