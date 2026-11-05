/**
 * 存储接口 —— 服务端只认这个接口，不认具体实现。
 *
 * MemoryStore 给测试和「没配 DATABASE_URL 时也能起」用；
 * PostgresStore 是 M0 之后的事实源实现。两者行为必须一致，否则测试就没意义了。
 */

import { randomUUID } from 'node:crypto';

import { currentPeriod, decideQuota, entityKey, normalizeEntityName, periodStart, planLimit, type QuotaDecision, type QuotaState } from '@rakko/core';
import type { Automation, Graph, Memory, MemoryStatus, Message, MessageKind, MessageRole, RiskLevel, Run, RunEvent, Settings, Skill, Thread, Usage } from '@rakko/protocol';

export interface AppendMessageInput {
  threadId: string;
  role: MessageRole;
  text: string;
  /** 默认 text；工具调用与审批也走同一张表，重会话才能重放 */
  kind?: MessageKind;
  payload?: Record<string, unknown> | null;
  runId?: string | null;
}

export interface ForkInput {
  threadId: string;
  messageId: string;
  /** true = 连这条消息一起复制；false = 只复制它之前的 */
  includeTarget: boolean;
  title?: string;
}

export interface CreateRunInput {
  threadId: string;
  prompt: string;
  model: string;
}

export type RunPatch = Partial<Pick<Run, 'state' | 'error' | 'finishedAt' | 'model'>>;

export type Listener = (event: RunEvent) => void;

/** 重启后还等着人点头的那一次调用 */
/** 一条「实体 —关系→ 实体」，从记忆里抽出来 */
export interface TripleInput {
  from: string;
  relation: string;
  to: string;
  fromKind?: string;
  toKind?: string;
}

export interface MemorySearchOptions {
  /** 原始查询文本，关键词兜底用 */
  query: string;
  /** 查询向量；拿不到 embedding 时传 null */
  embedding: number[] | null;
  limit: number;
  /** 余弦下限：低于它的语义结果不注入，避免「不相关也塞进去」。默认 0.25 */
  minScore?: number;
}

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
  /** 技能：可挂载的规则块 */
  listSkills(): Promise<Skill[]>;
  createSkill(input: { name: string; description?: string; body: string; tools?: string[] }): Promise<Skill>;
  updateSkill(id: string, patch: Partial<Pick<Skill, 'name' | 'description' | 'body' | 'tools'>>): Promise<Skill | undefined>;
  deleteSkill(id: string): Promise<boolean>;

  /** 记忆：跨会话留下的东西 */
  listMemories(): Promise<Memory[]>;
  createMemory(input: {
    kind: Memory['kind'];
    title: string;
    description?: string;
    body: string;
    status?: MemoryStatus;
    embedding?: number[] | null;
  }): Promise<Memory>;
  /** 语义检索（没有向量时退回关键词），只返回 active 的记忆 */
  searchMemories(options: MemorySearchOptions): Promise<Memory[]>;
  /** 图谱扩展：沿实体关系找 1 跳内的相邻记忆 */
  expandFromMemories(memoryIds: string[], limit: number): Promise<Memory[]>;
  /** 知识图谱快照 */
  listGraph(): Promise<Graph>;
  /** 把一条记忆抽出的三元组写进图谱 */
  saveTriples(memoryId: string, triples: TripleInput[]): Promise<void>;
  /** 清掉孤立的实体节点（没有任何边连着），返回删了几个 */
  pruneOrphanNodes(): Promise<number>;
  updateMemory(id: string, patch: Partial<Pick<Memory, 'kind' | 'title' | 'description' | 'body' | 'status'>>): Promise<Memory | undefined>;
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
  /**
   * 分叉：把某条消息之前（或含它）的历史复制成一个新会话。
   * 「编辑后再问」= 复制到这条之前，然后用新文本跑一轮；「从这里另开一枝」= 连它一起复制。
   * 消息找不到就返回 null。
   */
  forkThread(input: ForkInput): Promise<{ thread: Thread; copied: number } | null>;
  /** 分页：取比 beforeSeq 更早的 limit 条（升序返回），hasMore 表示还有更早的 */
  pageMessages(threadId: string, options: { limit: number; beforeSeq?: number }): Promise<{ items: Message[]; hasMore: boolean }>;
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

const cosine = (a: number[], b: number[]): number => {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
};

const slugify = (name: string): string => {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii || 'skill-' + Math.random().toString(36).slice(2, 8);
};

/** 三个开箱可用的技能：挂上就生效，内容直接拼进系统提示 */
export const BUILTIN_SKILLS: Array<{ slug: string; name: string; description: string; body: string; tools?: string[] }> = [
  {
    slug: 'code-review',
    name: '代码审查',
    description: '提交前按这份清单过一遍',
    body: [
      '审查改动时按这个顺序看：',
      '1. 行为：边界、并发、失败路径、空值——先问「什么情况下会坏」。',
      '2. 一致性：有没有第二套写法做同一件事；有没有绕过既有的抽象。',
      '3. 证据：改完必须跑相关测试；测试没覆盖的地方要说明。',
      '4. 表达：注释解释「为什么」，不解释「是什么」。',
      '只报能复现的问题，不猜「可能有问题」。',
    ].join('\n'),
  },
  {
    slug: 'write-tests-first',
    name: '先写测试',
    description: '修 bug 前先把它变成一条会红的测试',
    body: [
      '修 bug 的固定动作：',
      '1. 先写一条能稳定复现的测试，确认它现在红。',
      '2. 再改实现，让这条测试变绿，别顺手改测试让它通过。',
      '3. 测试要能挡住回归：换个错误的实现，它应该变红。',
      '4. 边界写进测试里（并发、超时、空输入），不要只测顺利路径。',
    ].join('\n'),
  },
  {
    slug: 'read-only',
    name: '只读模式',
    description: '只许看，不许改：禁用写文件、跑命令与发请求',
    body: [
      '这次运行只做只读操作：读文件、列目录、grep 搜索。',
      '不能写文件、不能跑命令、不能发外部请求——需要动手时先把方案说清楚，等我确认。',
    ].join('\n'),
    tools: ['read_file', 'list_dir', 'grep'],
  },
  {
    slug: 'plain-chinese',
    name: '说人话',
    description: '中文回复的具体要求',
    body: [
      '回复要求：',
      '- 先说结论，再说理由；不要「好的，我来帮你…」这种开场。',
      '- 代码、命令、路径、标识符保持原样，不翻译。',
      '- 不确定就说不确定，并指出缺什么信息。',
      '- 一段话只讲一件事；长清单先给一句总述。',
    ].join('\n'),
  },
];

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
  private readonly embeddings = new Map<string, number[]>();
  private readonly graphNodes = new Map<
    string,
    { id: string; name: string; key: string; kind: string; memoryId: string | null; createdAt: string }
  >();
  private readonly graphEdges = new Map<string, { id: string; fromId: string; toId: string; relation: string; memoryId: string | null; createdAt: string }>();
  private readonly skills = new Map<string, Skill>();

  constructor(options: MemoryStoreOptions = {}) {
    const degradeOnExceed = options.degradeOnExceed ?? true;
    this.settings = { degradeOnExceed, approvedTools: [], enabledSkills: [], autoExtractMemory: true };
    this.quota = {
      limit: options.limit ?? planLimit('pro'),
      used: options.used ?? 0,
      degradeOnExceed,
    };

    for (const builtin of BUILTIN_SKILLS) {
      const skill: Skill = {
        id: randomUUID(),
        slug: builtin.slug,
        name: builtin.name,
        description: builtin.description,
        body: builtin.body,
        tools: builtin.tools ?? [],
        builtin: true,
        createdAt: now(),
      };
      this.skills.set(skill.id, skill);
    }
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

  async searchMemories(options: MemorySearchOptions): Promise<Memory[]> {
    const active = [...this.memories.values()].filter((memory) => memory.status !== 'pending');
    const keyword = options.query.toLowerCase();

    const minScore = options.minScore ?? 0.25;
    const scored = active.map((memory) => {
      const vector = this.embeddings.get(memory.id);
      const semantic = options.embedding && vector ? cosine(vector, options.embedding) : 0;
      const text = `${memory.title} ${memory.description} ${memory.body}`.toLowerCase();
      const lexical = keyword && text.includes(keyword) ? 1 : 0;
      // 语义低于阈值就不算命中，除非关键词对上了
      const score = lexical > 0 ? Math.max(semantic, minScore) : semantic >= minScore ? semantic : 0;
      return { memory, score };
    });

    const matched = scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score);

    // 有向量时就不拿「不相关但最近」的来填空，宁少勿滥
    const semanticReady = Boolean(options.embedding && options.embedding.length > 0);
    if (semanticReady) return matched.slice(0, options.limit).map((item) => item.memory);

    const rest = scored.filter((item) => item.score === 0).sort((a, b) => b.memory.updatedAt.localeCompare(a.memory.updatedAt));
    return [...matched, ...rest].slice(0, options.limit).map((item) => item.memory);
  }

  async expandFromMemories(memoryIds: string[], limit: number): Promise<Memory[]> {
    if (memoryIds.length === 0) return [];
    const seeds = new Set(memoryIds);

    // 1) 这些记忆里的实体
    const startNodes = [...this.graphNodes.values()].filter((node) => node.memoryId && seeds.has(node.memoryId));
    if (startNodes.length === 0) return [];
    const startIds = new Set(startNodes.map((node) => node.id));

    // 2) 与它们直接相连的实体
    const neighborIds = new Set<string>();
    for (const edge of this.graphEdges.values()) {
      if (startIds.has(edge.fromId)) neighborIds.add(edge.toId);
      if (startIds.has(edge.toId)) neighborIds.add(edge.fromId);
    }
    for (const id of startIds) neighborIds.delete(id);

    // 3) 邻居实体指向的其他记忆
    const out: Memory[] = [];
    const seen = new Set<string>();
    for (const node of this.graphNodes.values()) {
      if (!neighborIds.has(node.id) || !node.memoryId) continue;
      if (seeds.has(node.memoryId) || seen.has(node.memoryId)) continue;
      const memory = this.memories.get(node.memoryId);
      if (!memory || memory.status === 'pending') continue;
      seen.add(memory.id);
      out.push(memory);
      if (out.length >= limit) break;
    }
    return out;
  }

  async listGraph(): Promise<Graph> {
    return { nodes: [...this.graphNodes.values()], edges: [...this.graphEdges.values()] };
  }

  async saveTriples(memoryId: string, triples: TripleInput[]): Promise<void> {
    const at = now();
    for (const triple of triples) {
      const from = this.ensureNode(triple.from, triple.fromKind ?? 'concept', memoryId, at);
      const to = this.ensureNode(triple.to, triple.toKind ?? 'concept', memoryId, at);
      const key = `${from.id}|${to.id}|${triple.relation}`;
      if (!this.graphEdges.has(key)) {
        this.graphEdges.set(key, { id: randomUUID(), fromId: from.id, toId: to.id, relation: triple.relation, memoryId, createdAt: at });
      }
    }
  }

  async pruneOrphanNodes(): Promise<number> {
    const linked = new Set<string>();
    for (const edge of this.graphEdges.values()) {
      linked.add(edge.fromId);
      linked.add(edge.toId);
    }
    let removed = 0;
    for (const [id] of this.graphNodes) {
      if (linked.has(id)) continue;
      this.graphNodes.delete(id);
      removed += 1;
    }
    return removed;
  }

  /** 同名但大小写/空格不同的实体合并成一个 */
  private ensureNode(name: string, kind: string, memoryId: string, at: string) {
    const display = normalizeEntityName(name);
    const key = entityKey(name);
    const existing = [...this.graphNodes.values()].find((node) => node.key === key);
    if (existing) return existing;
    const node = { id: randomUUID(), name: display, key, kind, memoryId, createdAt: at };
    this.graphNodes.set(node.id, node);
    return node;
  }

  async listSkills(): Promise<Skill[]> {
    return [...this.skills.values()].sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async createSkill(input: { name: string; description?: string; body: string; tools?: string[] }): Promise<Skill> {
    const skill: Skill = {
      id: randomUUID(),
      slug: slugify(input.name),
      name: input.name,
      description: input.description ?? '',
      body: input.body,
      tools: input.tools ?? [],
      builtin: false,
      createdAt: now(),
    };
    this.skills.set(skill.id, skill);
    return skill;
  }

  async updateSkill(id: string, patch: Partial<Pick<Skill, 'name' | 'description' | 'body' | 'tools'>>): Promise<Skill | undefined> {
    const current = this.skills.get(id);
    if (!current) return undefined;
    const next: Skill = { ...current, ...patch };
    this.skills.set(id, next);
    return next;
  }

  async deleteSkill(id: string): Promise<boolean> {
    const current = this.skills.get(id);
    if (!current || current.builtin) return false;
    return this.skills.delete(id);
  }

  async listMemories(): Promise<Memory[]> {
    return [...this.memories.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createMemory(input: {
    kind: Memory['kind'];
    title: string;
    description?: string;
    body: string;
    status?: MemoryStatus;
    embedding?: number[] | null;
  }): Promise<Memory> {
    const at = now();
    const memory: Memory = {
      id: randomUUID(),
      kind: input.kind,
      status: input.status ?? 'active',
      title: input.title,
      description: input.description ?? '',
      body: input.body,
      createdAt: at,
      updatedAt: at,
    };
    this.memories.set(memory.id, memory);
    if (input.embedding && input.embedding.length > 0) this.embeddings.set(memory.id, input.embedding);
    return memory;
  }

  async updateMemory(
    id: string,
    patch: Partial<Pick<Memory, 'kind' | 'title' | 'description' | 'body' | 'status'>>,
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
    return {
      ...this.settings,
      approvedTools: [...this.settings.approvedTools],
      enabledSkills: [...this.settings.enabledSkills],
    };
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    if (typeof patch.degradeOnExceed === 'boolean') {
      this.settings = { ...this.settings, degradeOnExceed: patch.degradeOnExceed };
      this.quota = { ...this.quota, degradeOnExceed: patch.degradeOnExceed };
    }
    if (Array.isArray(patch.approvedTools)) {
      this.settings = { ...this.settings, approvedTools: [...new Set(patch.approvedTools)] };
    }
    if (Array.isArray(patch.enabledSkills)) {
      this.settings = { ...this.settings, enabledSkills: [...new Set(patch.enabledSkills)] };
    }
    if (typeof patch.autoExtractMemory === 'boolean') {
      this.settings = { ...this.settings, autoExtractMemory: patch.autoExtractMemory };
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

  async pageMessages(
    threadId: string,
    options: { limit: number; beforeSeq?: number },
  ): Promise<{ items: Message[]; hasMore: boolean }> {
    const all = this.messages.get(threadId) ?? [];
    const end = options.beforeSeq ? all.findIndex((message) => message.seq >= options.beforeSeq!) : all.length;
    const stop = end === -1 ? all.length : end;
    const start = Math.max(0, stop - options.limit);
    return { items: all.slice(start, stop), hasMore: start > 0 };
  }

  async forkThread(input: ForkInput): Promise<{ thread: Thread; copied: number } | null> {
    const origin = this.threads.get(input.threadId);
    if (!origin) return null;

    const all = this.messages.get(input.threadId) ?? [];
    const target = all.find((message) => message.id === input.messageId);
    if (!target) return null;

    const upto = input.includeTarget ? target.seq : target.seq - 1;
    const kept = all.filter((message) => message.seq <= upto);

    const thread = await this.createThread(input.title ?? `${origin.title} · 分叉`);
    for (const message of kept) {
      await this.appendMessage({
        threadId: thread.id,
        role: message.role,
        kind: message.kind,
        text: message.text,
        payload: message.payload ?? null,
        runId: message.runId,
      });
    }
    return { thread, copied: kept.length };
  }

  async appendMessage(input: AppendMessageInput): Promise<Message> {
    const existing = this.messages.get(input.threadId) ?? [];
    const message: Message = {
      id: randomUUID(),
      threadId: input.threadId,
      seq: (existing.at(-1)?.seq ?? 0) + 1,
      role: input.role,
      kind: input.kind ?? 'text',
      text: input.text,
      payload: input.payload ?? null,
      runId: input.runId ?? null,
      createdAt: now(),
    };
    existing.push(message);
    this.messages.set(input.threadId, existing);

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
