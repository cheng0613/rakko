import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/postgres-js/migrator';

import type { DbHandle } from './index.js';

/**
 * 迁移目录定位：dist/migrate.js -> ../migrations。
 * 故意不读 cwd —— 从哪个目录起服务都不会找错。
 */
export function defaultMigrationsFolder(): string {
  return fileURLToPath(new URL('../migrations', import.meta.url));
}

export async function migrateDb(handle: DbHandle, folder: string = defaultMigrationsFolder()): Promise<void> {
  await migrate(handle.db, { migrationsFolder: folder });
}
