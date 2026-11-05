import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';

const app = createApp();

const shutdown = async (signal: string): Promise<void> => {
  app.log?.info?.({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port, host });
  console.log(`rakko-api 已启动：http://${host}:${port}`);
} catch (error) {
  console.error('rakko-api 启动失败：', error);
  process.exit(1);
}
