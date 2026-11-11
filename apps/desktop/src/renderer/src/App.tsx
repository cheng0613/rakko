import { useCallback, useEffect, useState } from "react";
import type { PermissionMode, RakkoApi } from "@rakko/shared";
import { PERMISSION_MODES, PERMISSION_MODE_LABEL } from "@rakko/shared";
import { ChatPage } from "./chat/ChatPage.js";
import { HomePage } from "./home/HomePage.js";
import { Dock, type DockRoute } from "./layout/Dock.js";

declare global {
  interface Window {
    rakko: RakkoApi;
  }
}

type Route = DockRoute;

/**
 * 应用外壳 + 极简路由。
 *
 * P0 只有两个页面：首页与对话。dock 上其它入口（自动化/搜索/子代理/插件）
 * 还没有对应的设计稿与实现，这里不放假按钮 —— 等做了再加。
 */
export default function App() {
  const [appInfo, setAppInfo] = useState<{ name: string; version: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>("home");
  const [mode, setMode] = useState<PermissionMode>("ask");
  /** 从首页带进对话的初始文本 */
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);

  useEffect(() => {
    if (!window.rakko) {
      setError("preload 桥没接通：window.rakko 不存在");
      return;
    }
    let cancelled = false;
    window.rakko
      .getAppInfo()
      .then((info) => {
        if (!cancelled) setAppInfo(info);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const cycleMode = useCallback(() => {
    setMode((prev) => {
      const idx = PERMISSION_MODES.indexOf(prev);
      return PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length]!;
    });
  }, []);

  const startFromHome = useCallback((prompt: string) => {
    setPendingPrompt(prompt);
    setRoute("chat");
  }, []);

  if (error) {
    return (
      <div style={{ padding: 32 }}>
        <h2 style={{ color: "var(--warn)" }}>启动失败</h2>
        <p className="mono" style={{ marginTop: 8, color: "var(--ink2)" }}>
          {error}
        </p>
      </div>
    );
  }

  return (
    <div className="app-deck">
      <Dock route={route} onNavigate={setRoute} />

      <div className="app-main">
        {route === "home" ? (
          <HomePage
            appInfo={appInfo}
            onStartTask={startFromHome}
            onSubmit={startFromHome}
            permissionLabel={PERMISSION_MODE_LABEL[mode]}
            onCyclePermission={cycleMode}
          />
        ) : (
          <ChatPage
            appInfo={appInfo}
            initialMode={mode}
            onModeChange={setMode}
            initialPrompt={pendingPrompt}
            onConsumeInitialPrompt={() => setPendingPrompt(null)}
          />
        )}
      </div>
    </div>
  );
}
