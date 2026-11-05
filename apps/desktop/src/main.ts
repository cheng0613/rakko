/**
 * 桌面壳：一个窗口，加一个本地服务。
 *
 * 启动顺序刻意简单：先看服务在不在，不在就用 Electron 自带的 node
 * （ELECTRON_RUN_AS_NODE）把 apps/server 拉起来，等 /health 通了再开窗口。
 * 打包与签名不在这一轮范围内 —— 这里只是一个能双击开的壳。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { app, BrowserWindow, shell } from 'electron';

const SMOKE = process.argv.includes('--smoke');
const PORT = Number(process.env.PORT ?? 8787);
const SERVER_URL = process.env.RAKKO_SERVER_URL ?? `http://127.0.0.1:${PORT}`;

let serverProcess: ChildProcess | null = null;
let window: BrowserWindow | null = null;

/**
 * 双击打开的 app 没有 shell 环境变量，.env 得自己读。
 * 只认最朴素的 KEY=VALUE，不做变量展开 —— 够用了，也少一类事故。
 */
async function loadDotEnv(): Promise<Record<string, string>> {
  const candidates = [
    path.join(app.getAppPath(), '.env'),
    path.join(app.getAppPath(), '..', '..', '.env'), // 仓库根（开发态）
  ];
  for (const file of candidates) {
    try {
      const text = await readFile(file, 'utf8');
      const env: Record<string, string> = {};
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const index = trimmed.indexOf('=');
        if (index <= 0) continue;
        const key = trimmed.slice(0, index).trim();
        const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
        env[key] = value;
      }
      console.log(`已读取环境变量：${file}`);
      return env;
    } catch {
      // 没有就换下一个
    }
  }
  return {};
}

const waitForHealth = async (url: string, timeoutMs = 20_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return true;
    } catch {
      // 还没起来，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
};

const ensureServer = async (): Promise<void> => {
  if (await waitForHealth(SERVER_URL, 1_200)) return;

  const entry = path.join(app.getAppPath(), '..', 'server', 'dist', 'index.js');
  const dotenv = await loadDotEnv();
  serverProcess = spawn(process.execPath, [entry], {
    // 显式传的 shell env 优先，其次 .env
    env: { ...dotenv, ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(PORT) },
    stdio: 'inherit',
  });
  serverProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`服务进程退出，code=${code}`);
  });

  if (!(await waitForHealth(SERVER_URL))) {
    console.error('服务没起来，窗口仍会打开（界面会自己进演示模式）');
  }
};

const createWindow = async (): Promise<void> => {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    show: !SMOKE,
    backgroundColor: '#f5f5f7',
    title: 'Rakko',
    autoHideMenuBar: true,
    webPreferences: {
      // 界面是普通网页，不需要 node 能力
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // 外链交给系统浏览器，窗口里只待自己的界面
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  await window.loadURL(SERVER_URL);

  if (SMOKE) {
    // 冒烟不只看「页面加载成功」，还要真渲染出像素来
    const shot = process.env.RAKKO_SMOKE_SHOT ?? path.join(tmpdir(), 'rakko-desktop-smoke.png');
    await new Promise((resolve) => setTimeout(resolve, 800));
    const image = await window.webContents.capturePage();
    await writeFile(shot, image.toPNG());

    const title = window.webContents.getTitle();
    const url = window.webContents.getURL();
    console.log(`SMOKE_OK title="${title}" url="${url}" shot="${shot}"`);
    window.destroy();
    app.quit();
  }
};

app.whenReady().then(async () => {
  await ensureServer();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    serverProcess = null;
  }
});
