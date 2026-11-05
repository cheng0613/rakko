import { defineConfig } from 'drizzle-kit';

/** 生成 SQL 迁移：pnpm --filter @rakko/db db:generate */
export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://rakko:rakko@127.0.0.1:5433/rakko',
  },
  strict: true,
  verbose: true,
});
