/**
 * 桌面壳：一个窗口，加一个本地服务。
 *
 * 启动顺序刻意简单：先看服务在不在，不在就用 Electron 自带的 node
 * （ELECTRON_RUN_AS_NODE）把 apps/server 拉起来，等 /health 通了再开窗口。
 * 打包与签名不在这一轮范围内 —— 这里只是一个能双击开的壳。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import { app, BrowserWindow, shell } from 'electron';

const SMOKE = process.argv.includes('--smoke');
const PORT = Number(process.env.PORT ?? 8787);
const SERVER_URL = process.env.RAKKO_SERVER_URL ?? `http://127.0.0.1:${PORT}`;

let serverProcess: ChildProcess | null = null;
let window: BrowserWindow | null = null;

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
  serverProcess = spawn(process.execPath, [entry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(PORT) },
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
    const title = window.webContents.getTitle();
    const url = window.webContents.getURL();
    console.log(`SMOKE_OK title="${title}" url="${url}"`);
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
