import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema.js';

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  /** 直接用原始连接跑迁移或健康检查 */
  sql: postgres.Sql;
  close: () => Promise<void>;
}

/**
 * Postgres 独占事实源：进程里没有内存缓存层，读不到就是读不到，不假装成功。
 * 连接数刻意压低 —— 多实例部署时 10 × N 才是真实压力。
 */
export function createDb(databaseUrl: string, options: { max?: number } = {}): DbHandle {
  const sql = postgres(databaseUrl, { max: options.max ?? 10, onnotice: () => {} });
  return {
    db: drizzle(sql, { schema }),
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

export async function ping(handle: DbHandle): Promise<boolean> {
  try {
    await handle.sql`select 1`;
    return true;
  } catch {
    return false;
  }
}

export * from './schema.js';
export { defaultMigrationsFolder, migrateDb } from './migrate.js';
