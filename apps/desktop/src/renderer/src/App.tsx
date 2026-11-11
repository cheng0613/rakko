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
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

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

  /**
   * 确保有一个真实会话。
   *
   * 流程：打开（或复用）项目 → 建会话 → 拿到 id。
   * P0 阶段固定用当前工作目录作为项目。
   */
  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (sessionId) return sessionId;
    try {
      const project = await window.rakko.openProject(".");
      const session = await window.rakko.createSession(project.id);
      setSessionId(session.id);
      setSessionError(null);
      return session.id;
    } catch (e) {
      setSessionError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [sessionId]);

  const startFromHome = useCallback(
    (prompt: string) => {
      setPendingPrompt(prompt);
      setRoute("chat");
      void ensureSession();
    },
    [ensureSession],
  );

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
        ) : sessionId ? (
          <ChatPage
            sessionId={sessionId}
            appInfo={appInfo}
            initialMode={mode}
            onModeChange={setMode}
            initialPrompt={pendingPrompt}
            onConsumeInitialPrompt={() => setPendingPrompt(null)}
          />
        ) : (
          <div style={{ padding: 32, color: "var(--ink3)" }}>
            {sessionError ? (
              <span style={{ color: "var(--warn)" }}>创建会话失败：{sessionError}</span>
            ) : (
              "正在创建会话…"
            )}
          </div>
        )}
      </div>
    </div>
  );
}
