/**
 * 桌面壳：一个窗口，加一个本地服务。
 *
 * 启动顺序刻意简单：先看服务在不在，不在就用 Electron 自带的 node
 * （ELECTRON_RUN_AS_NODE）把服务拉起来，等 /health 通了再开窗口。
 *
 * 两种形态：
 *   - 开发态：服务入口是 apps/server/dist/index.js，界面由服务端在 / 吐出；
 *   - 打包后：服务被打成 resources/server.mjs，迁移文件在 resources/migrations。
 *
 * 还没做的：代码签名、自动更新、托盘。这一轮只保证「能装、能开、不双开」。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { app, BrowserWindow, screen, shell } from 'electron';

app.setName('Rakko');

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
    path.join(app.getPath('userData'), '.env'), // 装好之后用户自己放这里
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

/** 打包后服务与迁移都在 resources 下；开发态走仓库路径 */
function serverEntry(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'server.mjs');
  return path.join(app.getAppPath(), '..', 'server', 'dist', 'index.js');
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

  const dotenv = await loadDotEnv();
  const env: Record<string, string | undefined> = {
    ...dotenv,
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PORT: String(PORT),
  };
  if (app.isPackaged) {
    env.RAKKO_MIGRATIONS_DIR = path.join(process.resourcesPath, 'migrations');
    env.RAKKO_WEB_DIR = path.join(process.resourcesPath, 'web');

    // 安装目录通常不可写；默认工作区放用户数据里
    if (!env.RAKKO_WORKSPACE) {
      const workspaceDir = path.join(app.getPath('userData'), 'workspace');
      await mkdir(workspaceDir, { recursive: true });
      env.RAKKO_WORKSPACE = workspaceDir;
    }
  }

  serverProcess = spawn(process.execPath, [serverEntry()], {
    env,
    stdio: 'inherit',
  });
  serverProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`服务进程退出，code=${code}`);
  });

  if (!(await waitForHealth(SERVER_URL))) {
    console.error('服务没起来，窗口仍会打开（界面会自己进演示模式）');
  }
};

/* ---------------- 窗口状态：记住大小与位置 ---------------- */

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

const statePath = (): string => path.join(app.getPath('userData'), 'window-state.json');

async function loadWindowState(): Promise<WindowState | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath(), 'utf8')) as WindowState;
    if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') return null;

    // 屏幕换过 / 分辨率变小：别把窗口还原到看不见的地方
    const visible = screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      const right = (parsed.x ?? 0) + parsed.width;
      const bottom = (parsed.y ?? 0) + parsed.height;
      return (parsed.x ?? 0) < area.x + area.width && right > area.x && (parsed.y ?? 0) < area.y + area.height && bottom > area.y;
    });
    if (!visible) return { width: parsed.width, height: parsed.height, maximized: parsed.maximized };
    return parsed;
  } catch {
    return null;
  }
}

function saveWindowState(target: BrowserWindow): void {
  try {
    const maximized = target.isMaximized();
    const bounds = maximized ? target.getNormalBounds() : target.getBounds();
    const state: WindowState = { ...bounds, maximized };
    const file = statePath();
    void mkdir(path.dirname(file), { recursive: true }).then(() =>
      writeFile(file, JSON.stringify(state, null, 2), 'utf8'),
    );
  } catch {
    // 写不进去就算了，别因为记不住窗口大小把程序弄崩
  }
}

const createWindow = async (): Promise<void> => {
  const saved = await loadWindowState();

  window = new BrowserWindow({
    width: saved?.width ?? 1440,
    height: saved?.height ?? 900,
    ...(saved?.x !== undefined && saved?.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 1080,
    minHeight: 720,
    show: !SMOKE,
    backgroundColor: '#f5f5f7',
    title: 'Rakko',
    autoHideMenuBar: true,
    icon: app.isPackaged ? undefined : path.join(app.getAppPath(), 'build', 'icon-256.png'),
    webPreferences: {
      // 界面是普通网页，不需要 node 能力
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (saved?.maximized) window.maximize();

  // 外链交给系统浏览器，窗口里只待自己的界面
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // 只记「停下来时」的大小，拖动过程中写盘太频繁
  if (!SMOKE) {
    let timer: NodeJS.Timeout | null = null;
    const schedule = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (window) saveWindowState(window);
      }, 500);
    };
    window.on('resize', schedule);
    window.on('move', schedule);
    window.on('maximize', schedule);
    window.on('unmaximize', schedule);
    window.on('close', () => {
      if (timer) clearTimeout(timer);
      if (window) saveWindowState(window);
    });
  }

  await window.loadURL(SERVER_URL);

  if (SMOKE) {
    // 冒烟不只看「页面加载成功」，还要真渲染出像素来：等 .app 出现
    const shot = process.env.RAKKO_SMOKE_SHOT ?? path.join(tmpdir(), 'rakko-desktop-smoke.png');
    for (let i = 0; i < 40; i += 1) {
      const ready = await window.webContents.executeJavaScript("!!document.querySelector('.app')").catch(() => false);
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    // 顺手验证「窗口状态能落盘」：冒烟也会写一次，事后能检查文件
    saveWindowState(window);
    const image = await window.webContents.capturePage();
    await writeFile(shot, image.toPNG());

    const title = window.webContents.getTitle();
    const url = window.webContents.getURL();
    console.log(
      `SMOKE_OK title="${title}" url="${url}" packed=${app.isPackaged} shot="${shot}"`,
    );
    window.destroy();
    app.quit();
  }
};

// 只允许开一个：双击两次不该起两个服务、两个窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  app.whenReady().then(async () => {
    await ensureServer();
    await createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    serverProcess = null;
  }
});
