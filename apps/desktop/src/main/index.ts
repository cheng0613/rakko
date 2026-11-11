/**
 * Electron 主进程入口。
 *
 * 只做装配：窗口、IPC 路由、会话管理器、宿主能力注入。
 * 业务逻辑不写在这里 —— 见 packages/core。
 */
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ESM 里没有 __dirname。
 * 主进程产物是 ESM（package.json type: module），必须自己算。
 */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
import { PRODUCT_NAME } from "@rakko/shared";
import { registerIpc } from "./ipc/register.js";
import { SessionManager } from "./session/manager.js";
import { ProviderService } from "./provider/service.js";
import { PersistenceService } from "./persistence/service.js";

let mainWindow: BrowserWindow | null = null;
let sessions: SessionManager | null = null;
let providerService: ProviderService | null = null;
let persistence: PersistenceService | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: PRODUCT_NAME,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#141413" : "#e9e9e6",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(moduleDir, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void mainWindow.loadFile(path.join(moduleDir, "../renderer/index.html"));
  }
}

void app.whenReady().then(async () => {
  persistence = new PersistenceService();
  try {
    await persistence.open();
  } catch (e) {
    console.error("[db] 打开失败，会话将不会持久化：", e);
  }

  sessions = new SessionManager({
    getWindow: () => mainWindow,
    ...(persistence ? { persistence } : {}),
  });
  providerService = new ProviderService();
  registerIpc(ipcMain, sessions, providerService, persistence);

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// 退出前把子进程收干净，避免孤儿 pi 进程
app.on("before-quit", (event) => {
  if (!sessions) return;
  event.preventDefault();
  const s = sessions;
  sessions = null;
  void s.stopAll().finally(() => {
    persistence?.close();
    app.exit(0);
  });
});
