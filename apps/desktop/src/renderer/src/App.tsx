import { useCallback, useEffect, useState } from "react";
import type { PermissionMode, RakkoApi } from "@rakko/shared";
import { PERMISSION_MODES, PERMISSION_MODE_LABEL } from "@rakko/shared";
import { ChatPage } from "./chat/ChatPage.js";
import { HomePage } from "./home/HomePage.js";
import { useHomeData } from "./home/use-home-data.js";
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
  // 每次切到首页都重新读一次 —— 否则新建的会话不会出现
  const [homeRefreshKey, setHomeRefreshKey] = useState(0);
  const home = useHomeData(homeRefreshKey);

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
  }, []);

  const startFromHome = useCallback(
    (prompt: string) => {
      // 新任务：清掉旧会话 id，让 ensureSession 建一个新的
      setSessionId(null);
      setPendingPrompt(prompt);
      setRoute("chat");
    },
    [],
  );

  /** 打开一条历史会话 */
  const openSession = useCallback((id: string) => {
    setSessionId(id);
    setPendingPrompt(null);
    setRoute("chat");
  }, []);

  // 进对话页但没有会话时自动创建（覆盖 dock 切换、直接跳转等所有入口）
  useEffect(() => {
    if (route === "chat" && !sessionId && !sessionError) {
      void ensureSession();
    }
  }, [route, sessionId, sessionError, ensureSession]);

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
      <Dock
        route={route}
        onNavigate={(next) => {
          setRoute(next);
          if (next === "home") setHomeRefreshKey((k) => k + 1);
          // 进对话页时没会话就建一个，否则会卡在「正在创建会话」
          if (next === "chat" && !sessionId && !sessionError) void ensureSession();
        }}
      />

      <div className="app-main">
        {route === "home" ? (
          <HomePage
            appInfo={appInfo}
            sessions={home.sessions}
            lastSession={home.lastSession}
            loading={home.loading}
            error={home.error}
            onStartTask={startFromHome}
            onSubmit={startFromHome}
            onOpenSession={openSession}
            permissionLabel={PERMISSION_MODE_LABEL[mode]}
            onCyclePermission={cycleMode}
          />
        ) : sessionId ? (
          <ChatPage
            key={sessionId}
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
