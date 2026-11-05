import { createDb, migrateDb } from '@rakko/db';
import { createBuiltinTools, FakeProvider, OpenAICompatibleProvider, ProviderGateway, ToolRegistry } from '@rakko/core';

import { createApp, FAKE_MODELS } from './app.js';
import { loadAgentSettings, loadProviderSettings } from './config.js';
import { PostgresStore } from './postgres-store.js';
import { MemoryStore, type RunStore } from './store.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const databaseUrl = process.env.DATABASE_URL;

let store: RunStore;

if (databaseUrl) {
  const handle = createDb(databaseUrl, { max: Number(process.env.DB_POOL ?? 10) });
  console.log('存储：Postgres，应用迁移中…');
  await migrateDb(handle);
  const postgres = new PostgresStore(handle, { degradeOnExceed: loadAgentSettings().degradeOnExceed });
  await postgres.ready();
  store = postgres;
  console.log('存储：Postgres 就绪（九张表已建，默认用户已就位）');
  const recovered = await postgres.recoverOrphans();
  if (recovered > 0) console.log(`存储：清理了 ${recovered} 个上次没跑完的运行`);
} else {
  const policy = loadAgentSettings();
  store = new MemoryStore({ degradeOnExceed: policy.degradeOnExceed });
  console.log('存储：内存（未配置 DATABASE_URL，重启即清空）');
}

const settings = loadProviderSettings();
const hasKey = settings.apiKey.length > 0;

const gateway = new ProviderGateway({
  provider: hasKey
    ? new OpenAICompatibleProvider({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, timeoutMs: settings.timeoutMs })
    : new FakeProvider(),
  models: hasKey ? settings.models : FAKE_MODELS,
  firstChunkTimeoutMs: settings.firstChunkTimeoutMs,
});

if (hasKey) {
  console.log(`模型：${settings.baseUrl}`);
  console.log(`  标准档 ${settings.models.standard} · 快档 ${settings.models.fast}`);
} else {
  console.log('模型：假 provider（未配置 RAKKO_API_KEY，输出是固定文本）');
}

const agentSettings = loadAgentSettings();
const tools = new ToolRegistry({ workspace: agentSettings.workspace });
for (const tool of createBuiltinTools({ workspace: agentSettings.workspace, shellTimeoutMs: agentSettings.shellTimeoutMs })) {
  tools.register(tool);
}

console.log(`工作区：${agentSettings.workspace}`);
console.log(`工具：${tools.list().map((tool) => `${tool.name}(${tool.risk})`).join(' ')}
  审批超时 ${Math.round(agentSettings.approvalTimeoutMs / 1000)}s · 最多 ${agentSettings.maxSteps} 轮`);

const app = createApp({
  store,
  gateway,
  tools,
  workspace: agentSettings.workspace,
  approvalTimeoutMs: agentSettings.approvalTimeoutMs,
  maxSteps: agentSettings.maxSteps,
});

const shutdown = async (signal: string): Promise<void> => {
  console.log(`收到 ${signal}，正在退出…`);
  await app.close();
  await store.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port, host });
  console.log(`rakko-api 已启动：http://${host}:${port}`);
} catch (error) {
  console.error('rakko-api 启动失败：', error);
  await store.close();
  process.exit(1);
}
