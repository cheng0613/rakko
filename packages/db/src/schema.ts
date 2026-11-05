/**
 * M0 的九张表。Postgres 是唯一事实源 —— 没有本地缓存副本，也没有第二条写路径。
 *
 *   users          账号与计划
 *   threads        会话（一个会话一串消息）
 *   messages       消息，按 seq 排序
 *   runs           一次运行（配额按行数计）
 *   run_events     运行事件流，SSE 重放的来源
 *   automations    定时任务
 *   skills         技能
 *   memories       记忆
 *   usage_ledger   用量流水，配额对账用
 */

import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    /** free | pro | team */
    plan: text('plan').notNull().default('free'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_uq').on(table.email)],
);

export const threads = pgTable(
  'threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('新对话'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [index('threads_user_updated_idx').on(table.userId, table.updatedAt)],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    /** user | assistant | system | tool */
    role: text('role').notNull(),
    /** text | tool_call | tool_result | approval | approval_decision | notice */
    kind: text('kind').notNull().default('text'),
    text: text('text').notNull(),
    /** 非文本消息的结构化内容 */
    payload: jsonb('payload'),
    runId: uuid('run_id'),
    seq: integer('seq').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('messages_thread_seq_uq').on(table.threadId, table.seq)],
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** queued | running | waiting_approval | succeeded | failed | canceled */
    state: text('state').notNull().default('queued'),
    model: text('model').notNull(),
    prompt: text('prompt').notNull(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [index('runs_thread_created_idx').on(table.threadId, table.createdAt)],
);

export const runEvents = pgTable(
  'run_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** 单调递增，SSE 断线重连用 Last-Event-ID 续传 */
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('run_events_run_seq_uq').on(table.runId, table.seq)],
);

export const automations = pgTable(
  'automations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** cron 表达式，服务端统一时区 Asia/Shanghai */
    schedule: text('schedule').notNull(),
    prompt: text('prompt').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('automations_user_idx').on(table.userId)],
);

export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** null 表示内置技能 */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('skills_slug_uq').on(table.slug)],
);

export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** user | feedback | project | reference */
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('memories_user_kind_idx').on(table.userId, table.kind)],
);

export const usageLedger = pgTable(
  'usage_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    runId: uuid('run_id'),
    /** run | refund */
    kind: text('kind').notNull(),
    /** 配额按次数计，这里恒为 1 或 -1 */
    amount: integer('amount').notNull(),
    /** YYYY-MM，重置周期 */
    period: text('period').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('usage_user_period_idx').on(table.userId, table.period)],
);

export const threadsRelations = relations(threads, ({ many }) => ({
  messages: many(messages),
  runs: many(runs),
}));

export const runsRelations = relations(runs, ({ one, many }) => ({
  thread: one(threads, { fields: [runs.threadId], references: [threads.id] }),
  events: many(runEvents),
}));

/** 九张表就是 M0 的全部持久化面。加表要改这个数组和测试。 */
export const TABLES = [
  users,
  threads,
  messages,
  runs,
  runEvents,
  automations,
  skills,
  memories,
  usageLedger,
] as const;

export type User = typeof users.$inferSelect;
export type Thread = typeof threads.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type RunEventRow = typeof runEvents.$inferSelect;
export type Automation = typeof automations.$inferSelect;
export type Skill = typeof skills.$inferSelect;
export type Memory = typeof memories.$inferSelect;
export type UsageLedgerRow = typeof usageLedger.$inferSelect;
