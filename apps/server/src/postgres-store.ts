/**
 * Postgres 实现 —— 事实源。没有内存镜像，读不到就是读不到。
 *
 * 设计取舍：
 * - 消息与事件的 seq 由数据库算（子查询 + 唯一索引兜底并发），进程不维护计数器；
 * - 事件先落库再推送，SSE 断线重连才能只靠 Last-Event-ID 续上；
 * - 配额只认 usage_ledger 的求和，用户改不动这个数。
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import type { DbHandle } from '@rakko/db';
import { messages, runEvents, runs, threads, usageLedger, users } from '@rakko/db';
import { currentPeriod, decideQuota, periodStart, planLimit, type QuotaDecision } from '@rakko/core';
import type { Message, Run, RunEvent, RunState, Thread, Usage } from '@rakko/protocol';

import type { AppendMessageInput, CreateRunInput, Listener, RunPatch, RunStore } from './store.js';

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

const toThread = (row: typeof threads.$inferSelect): Thread => ({
  id: row.id,
  title: row.title,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toMessage = (row: typeof messages.$inferSelect): Message => ({
  id: row.id,
  threadId: row.threadId,
  role: row.role as Message['role'],
  text: row.text,
  runId: row.runId,
  createdAt: row.createdAt.toISOString(),
});

const toRun = (row: typeof runs.$inferSelect): Run => ({
  id: row.id,
  threadId: row.threadId,
  state: row.state as RunState,
  model: row.model,
  prompt: row.prompt,
  error: row.error,
  createdAt: row.createdAt.toISOString(),
  finishedAt: iso(row.finishedAt),
});

const planLabel = (plan: string): string => plan.charAt(0).toUpperCase() + plan.slice(1);

export interface PostgresStoreOptions {
  /** 本地单用户模式：首次启动自动建这个账号 */
  email?: string;
  plan?: string;
}

export class PostgresStore implements RunStore {
  readonly kind = 'postgres' as const;
  private readonly handle: DbHandle;
  private readonly email: string;
  private readonly plan: string;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly seqCache = new Map<string, number>();
  private userId: string | null = null;

  constructor(handle: DbHandle, options: PostgresStoreOptions = {}) {
    this.handle = handle;
    this.email = options.email ?? process.env.RAKKO_USER_EMAIL ?? 'local@rakko.app';
    this.plan = options.plan ?? process.env.RAKKO_PLAN ?? 'pro';
  }

  private get db(): DbHandle['db'] {
    return this.handle.db;
  }

  private requireUserId(): string {
    if (!this.userId) throw new Error('PostgresStore 还没 ready()，不能读写');
    return this.userId;
  }

  async ready(): Promise<void> {
    await this.db
      .insert(users)
      .values({ email: this.email, displayName: '本地用户', plan: this.plan })
      .onConflictDoNothing({ target: users.email });

    const [user] = await this.db.select().from(users).where(eq(users.email, this.email)).limit(1);
    if (!user) throw new Error(`默认用户 ${this.email} 建不出来`);
    this.userId = user.id;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  async listThreads(): Promise<Thread[]> {
    const rows = await this.db
      .select()
      .from(threads)
      .where(and(eq(threads.userId, this.requireUserId()), isNull(threads.archivedAt)))
      .orderBy(desc(threads.updatedAt));
    return rows.map(toThread);
  }

  async getThread(id: string): Promise<Thread | undefined> {
    const [row] = await this.db.select().from(threads).where(eq(threads.id, id)).limit(1);
    return row ? toThread(row) : undefined;
  }

  async createThread(title?: string): Promise<Thread> {
    const [row] = await this.db
      .insert(threads)
      .values({ userId: this.requireUserId(), title: title ?? '新对话' })
      .returning();
    if (!row) throw new Error('建会话失败');
    return toThread(row);
  }

  async listMessages(threadId: string): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(asc(messages.seq));
    return rows.map(toMessage);
  }

  async appendMessage(input: AppendMessageInput): Promise<Message> {
    const [row] = await this.db
      .insert(messages)
      .values({
        threadId: input.threadId,
        role: input.role,
        text: input.text,
        runId: input.runId ?? null,
        // seq 交给数据库算：唯一索引 (thread_id, seq) 会在并发时挡住重复
        seq: sql`coalesce((select max(${messages.seq}) from ${messages} where ${messages.threadId} = ${input.threadId}), 0) + 1`,
      })
      .returning();
    if (!row) throw new Error('写消息失败');

    await this.db.update(threads).set({ updatedAt: row.createdAt }).where(eq(threads.id, input.threadId));
    return toMessage(row);
  }

  async createRun(input: CreateRunInput): Promise<Run> {
    const userId = this.requireUserId();
    const row = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(runs)
        .values({ threadId: input.threadId, userId, prompt: input.prompt, model: input.model })
        .returning();
      if (!created) throw new Error('建运行失败');
      await tx.update(threads).set({ updatedAt: created.createdAt }).where(eq(threads.id, input.threadId));
      return created;
    });
    return toRun(row);
  }

  async getRun(id: string): Promise<Run | undefined> {
    const [row] = await this.db.select().from(runs).where(eq(runs.id, id)).limit(1);
    return row ? toRun(row) : undefined;
  }

  async patchRun(id: string, patch: RunPatch): Promise<Run | undefined> {
    const [row] = await this.db
      .update(runs)
      .set({
        ...(patch.state ? { state: patch.state } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt ? new Date(patch.finishedAt) : null } : {}),
        ...(patch.state === 'running' ? { startedAt: new Date() } : {}),
      })
      .where(eq(runs.id, id))
      .returning();
    return row ? toRun(row) : undefined;
  }

  async eventsOf(runId: string): Promise<RunEvent[]> {
    const rows = await this.db
      .select({ payload: runEvents.payload })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.seq));
    return rows.map((row) => row.payload as RunEvent);
  }

  async publish(event: RunEvent): Promise<void> {
    const seq = await this.nextSeq(event.runId);
    await this.db.insert(runEvents).values({
      runId: event.runId,
      seq,
      type: event.type,
      payload: event,
      at: new Date(event.at),
    });
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
    const usage = await this.usage();
    return decideQuota({ limit: usage.limit, used: usage.used, degradeOnExceed: usage.degradeOnExceed });
  }

  async chargeRun(run: Run): Promise<void> {
    await this.db.insert(usageLedger).values({
      userId: this.requireUserId(),
      runId: run.id,
      kind: 'run',
      amount: 1,
      period: currentPeriod(new Date(run.createdAt)),
    });
  }

  async usage(): Promise<Usage> {
    const userId = this.requireUserId();
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new Error('默认用户丢失');

    const period = currentPeriod();
    const [row] = await this.db
      .select({ total: sql<string>`coalesce(sum(${usageLedger.amount}), 0)` })
      .from(usageLedger)
      .where(and(eq(usageLedger.userId, userId), eq(usageLedger.period, period)));

    const used = Number(row?.total ?? 0);
    const limit = planLimit(user.plan);

    return {
      plan: planLabel(user.plan),
      limit,
      used,
      remaining: Math.max(0, limit - used),
      periodStart: periodStart(),
      degradeOnExceed: true,
    };
  }

  /** 每个运行一个 seq，先读一次库里的最大值，之后走内存。 */
  private async nextSeq(runId: string): Promise<number> {
    const cached = this.seqCache.get(runId);
    if (cached !== undefined) {
      const next = cached + 1;
      this.seqCache.set(runId, next);
      return next;
    }

    const [row] = await this.db
      .select({ max: sql<string>`coalesce(max(${runEvents.seq}), 0)` })
      .from(runEvents)
      .where(eq(runEvents.runId, runId));

    const next = Number(row?.max ?? 0) + 1;
    this.seqCache.set(runId, next);
    return next;
  }
}
