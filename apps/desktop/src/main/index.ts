/**
 * Electron 主进程入口。
 *
 * 只做装配：窗口、IPC 路由、宿主能力注入。
 * 业务逻辑不写在这里 —— 见 packages/core。
 */
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import path from "node:path";
import { PRODUCT_NAME } from "@rakko/shared";
import { registerIpc } from "./ipc/register.js";

let mainWindow: BrowserWindow | null = null;

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
      preload: path.join(__dirname, "../preload/index.mjs"),
      // 安全默认值：渲染进程不能直接碰 Node 或 electron
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 首帧画完再显示，避免白屏闪烁
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

void app.whenReady().then(() => {
  registerIpc(ipcMain);

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
