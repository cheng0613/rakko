/**
 * 存储接口 —— 服务端只认这个接口，不认具体实现。
 *
 * MemoryStore 给测试和「没配 DATABASE_URL 时也能起」用；
 * PostgresStore 是 M0 之后的事实源实现。两者行为必须一致，否则测试就没意义了。
 */

import { randomUUID } from 'node:crypto';

import { currentPeriod, decideQuota, periodStart, planLimit, type QuotaDecision, type QuotaState } from '@rakko/core';
import type { Automation, Memory, Message, MessageKind, MessageRole, RiskLevel, Run, RunEvent, Settings, Thread, Usage } from '@rakko/protocol';

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

/** 重启后还等着人点头的那一次调用 */
export interface PendingCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  risk: RiskLevel;
}

export interface ResumableRun {
  run: Run;
  /** null 表示审批已经做过、只差继续跑 */
  pending: PendingCall | null;
}

export interface RunStore {
  /** 供 /health 区分实现，运维一眼能看出接的哪个 */
  readonly kind: 'memory' | 'postgres';
  /** 建连接、迁移、准备默认用户 */
  ready(): Promise<void>;
  /** 进程重启后，把停在半路的运行标成失败（queued / running 无法续跑） */
  recoverOrphans(): Promise<number>;
  /** waiting_approval 的运行：重启后仍可恢复，返回待批的调用 */
  resumableRuns(): Promise<ResumableRun[]>;
  /** 线程最近一次运行，界面刷新后据此决定要不要接着看流 */
  latestRunForThread(threadId: string): Promise<Run | undefined>;
  /** 记忆：跨会话留下的东西 */
  listMemories(): Promise<Memory[]>;
  createMemory(input: { kind: Memory['kind']; title: string; description?: string; body: string }): Promise<Memory>;
  updateMemory(id: string, patch: Partial<Pick<Memory, 'kind' | 'title' | 'description' | 'body'>>): Promise<Memory | undefined>;
  deleteMemory(id: string): Promise<boolean>;

  /** 自动化：cron + 一句任务描述 */
  listAutomations(): Promise<Automation[]>;
  createAutomation(input: { name: string; schedule: string; prompt: string; enabled?: boolean }): Promise<Automation>;
  updateAutomation(id: string, patch: Partial<Pick<Automation, 'name' | 'schedule' | 'prompt' | 'enabled'>>): Promise<Automation | undefined>;
  deleteAutomation(id: string): Promise<boolean>;
  markAutomationRun(id: string, at: string): Promise<void>;
  /** 用户设置（用超了降级还是拦下） */
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  listThreads(): Promise<Thread[]>;
  getThread(id: string): Promise<Thread | undefined>;
  createThread(title?: string): Promise<Thread>;
  renameThread(id: string, title: string): Promise<Thread | undefined>;
  deleteThread(id: string): Promise<boolean>;
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
  private settings: Settings;
  private readonly automations = new Map<string, Automation>();
  private readonly memories = new Map<string, Memory>();

  constructor(options: MemoryStoreOptions = {}) {
    const degradeOnExceed = options.degradeOnExceed ?? true;
    this.settings = { degradeOnExceed, approvedTools: [] };
    this.quota = {
      limit: options.limit ?? planLimit('pro'),
      used: options.used ?? 0,
      degradeOnExceed,
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

  async resumableRuns(): Promise<ResumableRun[]> {
    return [];
  }

  async listMemories(): Promise<Memory[]> {
    return [...this.memories.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createMemory(input: { kind: Memory['kind']; title: string; description?: string; body: string }): Promise<Memory> {
    const at = now();
    const memory: Memory = {
      id: randomUUID(),
      kind: input.kind,
      title: input.title,
      description: input.description ?? '',
      body: input.body,
      createdAt: at,
      updatedAt: at,
    };
    this.memories.set(memory.id, memory);
    return memory;
  }

  async updateMemory(
    id: string,
    patch: Partial<Pick<Memory, 'kind' | 'title' | 'description' | 'body'>>,
  ): Promise<Memory | undefined> {
    const current = this.memories.get(id);
    if (!current) return undefined;
    const next: Memory = { ...current, ...patch, updatedAt: now() };
    this.memories.set(id, next);
    return next;
  }

  async deleteMemory(id: string): Promise<boolean> {
    return this.memories.delete(id);
  }

  async listAutomations(): Promise<Automation[]> {
    return [...this.automations.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async createAutomation(input: { name: string; schedule: string; prompt: string; enabled?: boolean }): Promise<Automation> {
    const automation: Automation = {
      id: randomUUID(),
      name: input.name,
      schedule: input.schedule,
      prompt: input.prompt,
      enabled: input.enabled ?? true,
      lastRunAt: null,
      createdAt: now(),
    };
    this.automations.set(automation.id, automation);
    return automation;
  }

  async updateAutomation(
    id: string,
    patch: Partial<Pick<Automation, 'name' | 'schedule' | 'prompt' | 'enabled'>>,
  ): Promise<Automation | undefined> {
    const current = this.automations.get(id);
    if (!current) return undefined;
    const next: Automation = { ...current, ...patch };
    this.automations.set(id, next);
    return next;
  }

  async deleteAutomation(id: string): Promise<boolean> {
    return this.automations.delete(id);
  }

  async markAutomationRun(id: string, at: string): Promise<void> {
    const current = this.automations.get(id);
    if (current) this.automations.set(id, { ...current, lastRunAt: at });
  }

  async getSettings(): Promise<Settings> {
    return { ...this.settings, approvedTools: [...this.settings.approvedTools] };
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    if (typeof patch.degradeOnExceed === 'boolean') {
      this.settings = { ...this.settings, degradeOnExceed: patch.degradeOnExceed };
      this.quota = { ...this.quota, degradeOnExceed: patch.degradeOnExceed };
    }
    if (Array.isArray(patch.approvedTools)) {
      this.settings = { ...this.settings, approvedTools: [...new Set(patch.approvedTools)] };
    }
    return this.getSettings();
  }

  async latestRunForThread(threadId: string): Promise<Run | undefined> {
    const list = [...this.runs.values()].filter((run) => run.threadId === threadId);
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
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

  async renameThread(id: string, title: string): Promise<Thread | undefined> {
    const thread = this.threads.get(id);
    if (!thread) return undefined;
    const next: Thread = { ...thread, title, updatedAt: now() };
    this.threads.set(id, next);
    return next;
  }

  async deleteThread(id: string): Promise<boolean> {
    if (!this.threads.delete(id)) return false;
    this.messages.delete(id);
    for (const [runId, run] of this.runs) {
      if (run.threadId === id) {
        this.runs.delete(runId);
        this.events.delete(runId);
        this.listeners.delete(runId);
      }
    }
    return true;
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
