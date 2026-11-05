import { randomUUID } from 'node:crypto';

import { decideQuota, type QuotaDecision, type QuotaState } from '@rakko/core';
import type { Message, MessageRole, Run, RunEvent, Thread, Usage } from '@rakko/protocol';

type Listener = (event: RunEvent) => void;

const now = (): string => new Date().toISOString();

const periodStart = (): string => {
  const date = new Date();
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
};

/**
 * M0 的内存实现：形状与 Postgres 版一致，M1 只换实现不换接口。
 * 进程重启即清空 —— 这是脚手架，不是事实源。
 */
export class Store {
  private readonly threads = new Map<string, Thread>();
  private readonly runs = new Map<string, Run>();
  private readonly messages = new Map<string, Message[]>();
  private readonly events = new Map<string, RunEvent[]>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private quota: QuotaState = { limit: 120, used: 62, degradeOnExceed: true };

  listThreads(): Thread[] {
    return [...this.threads.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getThread(id: string): Thread | undefined {
    return this.threads.get(id);
  }

  createThread(title?: string): Thread {
    const at = now();
    const thread: Thread = { id: randomUUID(), title: title ?? '新对话', createdAt: at, updatedAt: at };
    this.threads.set(thread.id, thread);
    this.messages.set(thread.id, []);
    return thread;
  }

  listMessages(threadId: string): Message[] {
    return this.messages.get(threadId) ?? [];
  }

  appendMessage(input: { threadId: string; role: MessageRole; text: string; runId?: string | null }): Message {
    const message: Message = {
      id: randomUUID(),
      threadId: input.threadId,
      role: input.role,
      text: input.text,
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

  createRun(input: { threadId: string; prompt: string; model: string }): Run {
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

  getRun(id: string): Run | undefined {
    return this.runs.get(id);
  }

  patchRun(id: string, patch: Partial<Pick<Run, 'state' | 'error' | 'finishedAt'>>): Run | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    const next: Run = { ...run, ...patch };
    this.runs.set(id, next);
    return next;
  }

  eventsOf(runId: string): RunEvent[] {
    return this.events.get(runId) ?? [];
  }

  publish(event: RunEvent): void {
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

  quotaDecision(): QuotaDecision {
    return decideQuota(this.quota);
  }

  chargeRun(): void {
    this.quota.used += 1;
  }

  usage(): Usage {
    return {
      plan: 'Pro',
      limit: this.quota.limit,
      used: this.quota.used,
      remaining: Math.max(0, this.quota.limit - this.quota.used),
      periodStart: periodStart(),
      degradeOnExceed: this.quota.degradeOnExceed,
    };
  }
}
