/**
 * Postgres 实现 —— 事实源。没有内存镜像，读不到就是读不到。
 *
 * 设计取舍：
 * - 消息与事件的 seq 由数据库算（子查询 + 唯一索引兜底并发），进程不维护计数器；
 * - 事件先落库再推送，SSE 断线重连才能只靠 Last-Event-ID 续上；
 * - 配额只认 usage_ledger 的求和，用户改不动这个数。
 */

import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import type { DbHandle } from '@rakko/db';
import { automations, kgEdges, kgNodes, memories, messages, runEvents, runs, skills, threads, usageLedger, users } from '@rakko/db';
import { currentPeriod, decideQuota, periodStart, planLimit, type QuotaDecision } from '@rakko/core';
import type { Automation, Graph, KgEdge, KgNode, Memory, MemoryKind, MemoryStatus, Message, MessageKind, RiskLevel, Run, RunEvent, RunState, Settings, Skill, Thread, Usage } from '@rakko/protocol';

import { entityKey, normalizeEntityName, toVectorLiteral } from '@rakko/core';

import { BUILTIN_SKILLS } from './store.js';
import type {
  AppendMessageInput,
  CreateRunInput,
  Listener,
  MemorySearchOptions,
  PendingCall,
  ResumableRun,
  RunPatch,
  RunStore,
  TripleInput,
} from './store.js';

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
  kind: row.kind as MessageKind,
  text: row.text,
  payload: (row.payload as Record<string, unknown> | null) ?? null,
  runId: row.runId,
  createdAt: row.createdAt.toISOString(),
});

const toKgNode = (row: typeof kgNodes.$inferSelect): KgNode => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  memoryId: row.memoryId,
  createdAt: row.createdAt.toISOString(),
});

const toKgEdge = (row: typeof kgEdges.$inferSelect): KgEdge => ({
  id: row.id,
  fromId: row.fromId,
  toId: row.toId,
  relation: row.relation,
  memoryId: row.memoryId,
  createdAt: row.createdAt.toISOString(),
});

const toSkill = (row: typeof skills.$inferSelect): Skill => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  description: row.description,
  body: row.body,
  tools: Array.isArray(row.tools) ? (row.tools as string[]) : [],
  builtin: row.userId === null,
  createdAt: row.createdAt.toISOString(),
});

const toMemory = (row: typeof memories.$inferSelect): Memory => ({
  id: row.id,
  kind: row.kind as MemoryKind,
  status: row.status as MemoryStatus,
  title: row.title,
  description: row.description,
  body: row.body,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toAutomation = (row: typeof automations.$inferSelect): Automation => ({
  id: row.id,
  name: row.name,
  schedule: row.schedule,
  prompt: row.prompt,
  enabled: row.enabled,
  lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
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
  /** 配额用超了是降级还是拦下 */
  degradeOnExceed?: boolean;
}

export class PostgresStore implements RunStore {
  readonly kind = 'postgres' as const;
  private readonly handle: DbHandle;
  private readonly email: string;
  private readonly plan: string;
  private readonly degradeOnExceed: boolean;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly seqCache = new Map<string, number>();
  private userId: string | null = null;

  constructor(handle: DbHandle, options: PostgresStoreOptions = {}) {
    this.handle = handle;
    this.email = options.email ?? process.env.RAKKO_USER_EMAIL ?? 'local@rakko.app';
    this.plan = options.plan ?? process.env.RAKKO_PLAN ?? 'pro';
    this.degradeOnExceed = options.degradeOnExceed ?? true;
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

    // 内置技能：userId 为 null，内容写死在代码里，可挂载不可删
    for (const builtin of BUILTIN_SKILLS) {
      await this.db
        .insert(skills)
        .values({
          userId: null,
          slug: builtin.slug,
          name: builtin.name,
          description: builtin.description,
          body: builtin.body,
          tools: builtin.tools ?? [],
        })
        .onConflictDoNothing({ target: skills.slug });
    }
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  /**
   * 只有 queued / running 真的没救了（没有进程在推事件流）。
   * waiting_approval 是可恢复的：审批还挂在库里，重启后接着等人点头。
   */
  async recoverOrphans(): Promise<number> {
    // 只清自己账号下的：这是「启动时收尸」，不是可以随便调用的全局重写
    const rows = await this.db
      .update(runs)
      .set({ state: 'failed', error: '服务重启，这次运行被中断了', finishedAt: new Date() })
      .where(and(eq(runs.userId, this.requireUserId()), inArray(runs.state, ['queued', 'running'])))
      .returning({ id: runs.id });
    return rows.length;
  }

  /** 找所有还在等审批的运行，并翻出那条没有结论的调用 */
  async resumableRuns(): Promise<ResumableRun[]> {
    const rows = await this.db.select().from(runs).where(eq(runs.state, 'waiting_approval'));
    const out: ResumableRun[] = [];

    for (const row of rows) {
      const items = await this.listMessages(row.threadId);
      const decided = new Set(
        items.filter((item) => item.kind === 'approval_decision').map((item) => String(item.payload?.callId ?? '')),
      );
      const waiting = [...items]
        .reverse()
        .find((item) => item.kind === 'approval' && !decided.has(String(item.payload?.callId ?? '')));

      const run = toRun(row);
      if (!waiting) {
        out.push({ run, pending: null });
        continue;
      }

      const payload = waiting.payload ?? {};
      const pending: PendingCall = {
        callId: String(payload.callId ?? ''),
        name: String(payload.name ?? ''),
        args: (payload.args as Record<string, unknown>) ?? {},
        risk: (payload.risk as RiskLevel) ?? 'high',
      };
      out.push({ run, pending });
    }

    return out;
  }

  async latestRunForThread(threadId: string): Promise<Run | undefined> {
    const [row] = await this.db
      .select()
      .from(runs)
      .where(eq(runs.threadId, threadId))
      .orderBy(desc(runs.createdAt))
      .limit(1);
    return row ? toRun(row) : undefined;
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

  async renameThread(id: string, title: string): Promise<Thread | undefined> {
    const [row] = await this.db
      .update(threads)
      .set({ title, updatedAt: new Date() })
      .where(and(eq(threads.id, id), eq(threads.userId, this.requireUserId())))
      .returning();
    return row ? toThread(row) : undefined;
  }

  async deleteThread(id: string): Promise<boolean> {
    // messages / runs / run_events 靠外键 cascade 跟着删
    const rows = await this.db
      .delete(threads)
      .where(and(eq(threads.id, id), eq(threads.userId, this.requireUserId())))
      .returning({ id: threads.id });
    return rows.length > 0;
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
    /**
     * seq 必须在「读 max + 写」之间不被插队，否则并发会撞 (thread_id, seq) 唯一索引。
     * 只靠重试能撑住小并发，压到 20 并发就开始丢消息（实测 16/20）。
     * 所以用会话行当锁：同一会话的追加排队进行，不同会话互不影响。
     */
    const created = await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ id: threads.id })
        .from(threads)
        .where(eq(threads.id, input.threadId))
        .for('update');
      if (!locked) throw new Error(`会话 ${input.threadId} 不存在，写不了消息`);

      const [row] = await tx
        .insert(messages)
        .values({
          threadId: input.threadId,
          role: input.role,
          kind: input.kind ?? 'text',
          text: input.text,
          payload: input.payload ?? null,
          runId: input.runId ?? null,
          seq: sql`coalesce((select max(${messages.seq}) from ${messages} where ${messages.threadId} = ${input.threadId}), 0) + 1`,
        })
        .returning();
      if (!row) throw new Error('写消息失败');

      await tx.update(threads).set({ updatedAt: row.createdAt }).where(eq(threads.id, input.threadId));
      return row;
    });

    return toMessage(created);
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
        ...(patch.model ? { model: patch.model } : {}),
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

  async listSkills(): Promise<Skill[]> {
    const rows = await this.db
      .select()
      .from(skills)
      .where(or(isNull(skills.userId), eq(skills.userId, this.requireUserId())))
      .orderBy(asc(skills.userId), asc(skills.name));
    return rows.map(toSkill);
  }

  async createSkill(input: { name: string; description?: string; body: string; tools?: string[] }): Promise<Skill> {
    const slug = input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `skill-${Date.now().toString(36)}`;

    const [row] = await this.db
      .insert(skills)
      .values({
        userId: this.requireUserId(),
        slug: `${slug}-${Date.now().toString(36)}`,
        name: input.name,
        description: input.description ?? '',
        body: input.body,
        tools: input.tools ?? [],
      })
      .returning();
    if (!row) throw new Error('建技能失败');
    return toSkill(row);
  }

  async updateSkill(id: string, patch: Partial<Pick<Skill, 'name' | 'description' | 'body' | 'tools'>>): Promise<Skill | undefined> {
    const [row] = await this.db
      .update(skills)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.tools !== undefined ? { tools: patch.tools } : {}),
      })
      .where(and(eq(skills.id, id), eq(skills.userId, this.requireUserId())))
      .returning();
    return row ? toSkill(row) : undefined;
  }

  async deleteSkill(id: string): Promise<boolean> {
    // 内置技能的 userId 是 null，条件天然挡掉
    const rows = await this.db
      .delete(skills)
      .where(and(eq(skills.id, id), eq(skills.userId, this.requireUserId())))
      .returning({ id: skills.id });
    return rows.length > 0;
  }

  async listMemories(): Promise<Memory[]> {
    const rows = await this.db
      .select()
      .from(memories)
      .where(eq(memories.userId, this.requireUserId()))
      .orderBy(desc(memories.updatedAt));
    return rows.map(toMemory);
  }

  async createMemory(input: {
    kind: MemoryKind;
    title: string;
    description?: string;
    body: string;
    status?: MemoryStatus;
    embedding?: number[] | null;
  }): Promise<Memory> {
    const [row] = await this.db
      .insert(memories)
      .values({
        userId: this.requireUserId(),
        kind: input.kind,
        title: input.title,
        description: input.description ?? '',
        body: input.body,
        status: input.status ?? 'active',
        ...(input.embedding && input.embedding.length > 0
          ? { embedding: sql`${toVectorLiteral(input.embedding)}::vector` }
          : {}),
      })
      .returning();
    if (!row) throw new Error('写记忆失败');
    return toMemory(row);
  }

  async searchMemories(options: MemorySearchOptions): Promise<Memory[]> {
    const userId = this.requireUserId();
    const like = `%${options.query.replace(/[%_]/g, '')}%`;

    if (options.embedding && options.embedding.length > 0) {
      const literal = toVectorLiteral(options.embedding);
      const minScore = options.minScore ?? 0.25;
      const distance = sql`${memories.embedding} <=> ${sql.raw(`'${literal}'::vector`)}`;
      const rows = await this.db
        .select()
        .from(memories)
        .where(
          and(
            eq(memories.userId, userId),
            eq(memories.status, 'active'),
            isNotNull(memories.embedding),
            // 余弦相似度 = 1 - 距离；低于阈值的干脆不取
            sql`1 - (${distance}) >= ${minScore}`,
          ),
        )
        .orderBy(distance)
        .limit(options.limit);
      if (rows.length > 0) return rows.map(toMemory);
    }

    // 没有向量：关键词兜底，再不行给最近更新的
    const rows = await this.db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.userId, userId),
          eq(memories.status, 'active'),
          or(ilike(memories.title, like), ilike(memories.body, like)),
        ),
      )
      .orderBy(desc(memories.updatedAt))
      .limit(options.limit);
    if (rows.length > 0) return rows.map(toMemory);

    const recent = await this.db
      .select()
      .from(memories)
      .where(and(eq(memories.userId, userId), eq(memories.status, 'active')))
      .orderBy(desc(memories.updatedAt))
      .limit(options.limit);
    return recent.map(toMemory);
  }

  async expandFromMemories(memoryIds: string[], limit: number): Promise<Memory[]> {
    if (memoryIds.length === 0) return [];
    const userId = this.requireUserId();
    const seeds = new Set(memoryIds);

    // 1) 这些记忆里的实体
    const startNodes = await this.db
      .select({ id: kgNodes.id })
      .from(kgNodes)
      .where(and(eq(kgNodes.userId, userId), inArray(kgNodes.memoryId, memoryIds)));
    if (startNodes.length === 0) return [];
    const startIds = startNodes.map((node) => node.id);

    // 2) 直接相连的实体（两个方向）
    const edges = await this.db
      .select({ fromId: kgEdges.fromId, toId: kgEdges.toId })
      .from(kgEdges)
      .where(and(eq(kgEdges.userId, userId), or(inArray(kgEdges.fromId, startIds), inArray(kgEdges.toId, startIds))));

    const startSet = new Set(startIds);
    const neighborIds = new Set<string>();
    for (const edge of edges) {
      if (startSet.has(edge.fromId)) neighborIds.add(edge.toId);
      if (startSet.has(edge.toId)) neighborIds.add(edge.fromId);
    }
    for (const id of startSet) neighborIds.delete(id);
    if (neighborIds.size === 0) return [];

    // 3) 邻居实体指向的其他记忆
    const rows = await this.db
      .select({ memoryId: kgNodes.memoryId })
      .from(kgNodes)
      .where(and(eq(kgNodes.userId, userId), inArray(kgNodes.id, [...neighborIds]), isNotNull(kgNodes.memoryId)));

    const wanted = [
      ...new Set(
        rows
          .map((row) => row.memoryId)
          .filter((id): id is string => typeof id === 'string' && !seeds.has(id)),
      ),
    ].slice(0, limit);
    if (wanted.length === 0) return [];

    const related = await this.db
      .select()
      .from(memories)
      .where(and(eq(memories.userId, userId), eq(memories.status, 'active'), inArray(memories.id, wanted)));

    return related.map(toMemory);
  }

  async listGraph(): Promise<Graph> {
    const userId = this.requireUserId();
    const [nodes, edges] = await Promise.all([
      this.db.select().from(kgNodes).where(eq(kgNodes.userId, userId)),
      this.db.select().from(kgEdges).where(eq(kgEdges.userId, userId)),
    ]);
    return { nodes: nodes.map(toKgNode), edges: edges.map(toKgEdge) };
  }

  async saveTriples(memoryId: string, triples: TripleInput[]): Promise<void> {
    const userId = this.requireUserId();
    for (const triple of triples) {
      const fromId = await this.ensureNode(userId, triple.from, triple.fromKind ?? 'concept', memoryId);
      const toId = await this.ensureNode(userId, triple.to, triple.toKind ?? 'concept', memoryId);
      await this.db
        .insert(kgEdges)
        .values({ userId, fromId, toId, relation: triple.relation, memoryId })
        .onConflictDoNothing();
    }

    await this.pruneOrphanNodes().catch(() => 0);
  }

  private async ensureNode(userId: string, name: string, kind: string, memoryId: string): Promise<string> {
    const key = entityKey(name);
    const display = normalizeEntityName(name);

    const [existing] = await this.db
      .select({ id: kgNodes.id })
      .from(kgNodes)
      .where(and(eq(kgNodes.userId, userId), eq(kgNodes.key, key)))
      .limit(1);
    if (existing) return existing.id;

    const [created] = await this.db
      .insert(kgNodes)
      .values({ userId, name: display, key, kind, memoryId })
      .onConflictDoNothing({ target: [kgNodes.userId, kgNodes.key] })
      .returning({ id: kgNodes.id });
    if (created) return created.id;

    const [again] = await this.db
      .select({ id: kgNodes.id })
      .from(kgNodes)
      .where(and(eq(kgNodes.userId, userId), eq(kgNodes.key, key)))
      .limit(1);
    if (!again) throw new Error(`建图谱节点失败：${name}`);
    return again.id;
  }

  /** 没有任何边连着的实体直接删掉，免得图谱越长越脏 */
  async pruneOrphanNodes(): Promise<number> {
    const userId = this.requireUserId();
    const rows = await this.db
      .delete(kgNodes)
      .where(
        and(
          eq(kgNodes.userId, userId),
          sql`not exists (select 1 from ${kgEdges} where ${kgEdges.fromId} = ${kgNodes.id} or ${kgEdges.toId} = ${kgNodes.id})`,
        ),
      )
      .returning({ id: kgNodes.id });
    return rows.length;
  }

  async updateMemory(
    id: string,
    patch: Partial<Pick<Memory, 'kind' | 'title' | 'description' | 'body' | 'status'>>,
  ): Promise<Memory | undefined> {
    const [row] = await this.db
      .update(memories)
      .set({
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(memories.id, id), eq(memories.userId, this.requireUserId())))
      .returning();
    return row ? toMemory(row) : undefined;
  }

  async deleteMemory(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(memories)
      .where(and(eq(memories.id, id), eq(memories.userId, this.requireUserId())))
      .returning({ id: memories.id });
    return rows.length > 0;
  }

  async listAutomations(): Promise<Automation[]> {
    const rows = await this.db
      .select()
      .from(automations)
      .where(eq(automations.userId, this.requireUserId()))
      .orderBy(asc(automations.name));
    return rows.map(toAutomation);
  }

  async createAutomation(input: { name: string; schedule: string; prompt: string; enabled?: boolean }): Promise<Automation> {
    const [row] = await this.db
      .insert(automations)
      .values({
        userId: this.requireUserId(),
        name: input.name,
        schedule: input.schedule,
        prompt: input.prompt,
        enabled: input.enabled ?? true,
      })
      .returning();
    if (!row) throw new Error('建自动化失败');
    return toAutomation(row);
  }

  async updateAutomation(
    id: string,
    patch: Partial<Pick<Automation, 'name' | 'schedule' | 'prompt' | 'enabled'>>,
  ): Promise<Automation | undefined> {
    const [row] = await this.db
      .update(automations)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
        ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      })
      .where(and(eq(automations.id, id), eq(automations.userId, this.requireUserId())))
      .returning();
    return row ? toAutomation(row) : undefined;
  }

  async deleteAutomation(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(automations)
      .where(and(eq(automations.id, id), eq(automations.userId, this.requireUserId())))
      .returning({ id: automations.id });
    return rows.length > 0;
  }

  async markAutomationRun(id: string, at: string): Promise<void> {
    await this.db.update(automations).set({ lastRunAt: new Date(at) }).where(eq(automations.id, id));
  }

  async getSettings(): Promise<Settings> {
    const [user] = await this.db.select().from(users).where(eq(users.id, this.requireUserId())).limit(1);
    const raw = (user?.settings ?? {}) as Partial<Settings>;
    return {
      degradeOnExceed: typeof raw.degradeOnExceed === 'boolean' ? raw.degradeOnExceed : this.degradeOnExceed,
      approvedTools: Array.isArray(raw.approvedTools) ? raw.approvedTools.filter((name) => typeof name === 'string') : [],
      enabledSkills: Array.isArray(raw.enabledSkills) ? raw.enabledSkills.filter((name) => typeof name === 'string') : [],
      autoExtractMemory: typeof raw.autoExtractMemory === 'boolean' ? raw.autoExtractMemory : true,
    };
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const current = await this.getSettings();
    const next: Settings = {
      degradeOnExceed: typeof patch.degradeOnExceed === 'boolean' ? patch.degradeOnExceed : current.degradeOnExceed,
      approvedTools: Array.isArray(patch.approvedTools) ? [...new Set(patch.approvedTools)] : current.approvedTools,
      enabledSkills: Array.isArray(patch.enabledSkills) ? [...new Set(patch.enabledSkills)] : current.enabledSkills,
      autoExtractMemory:
        typeof patch.autoExtractMemory === 'boolean' ? patch.autoExtractMemory : current.autoExtractMemory,
    };
    // 只认白名单里的键，别的脏数据不写进去
    await this.db
      .update(users)
      .set({
        settings: sql`coalesce(${users.settings}, '{}'::jsonb) || ${JSON.stringify({
          degradeOnExceed: next.degradeOnExceed,
          approvedTools: next.approvedTools,
          enabledSkills: next.enabledSkills,
          autoExtractMemory: next.autoExtractMemory,
        })}::jsonb`,
      })
      .where(eq(users.id, this.requireUserId()));
    return next;
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
    const settings = await this.getSettings();

    return {
      plan: planLabel(user.plan),
      limit,
      used,
      remaining: Math.max(0, limit - used),
      periodStart: periodStart(),
      degradeOnExceed: settings.degradeOnExceed,
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
