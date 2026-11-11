import { useCallback, useEffect, useState } from "react";
import type { PermissionMode, RakkoApi } from "@rakko/shared";
import { PERMISSION_MODES, PERMISSION_MODE_LABEL } from "@rakko/shared";
import { HomePage } from "./home/HomePage.js";
import { useHomeData } from "./home/use-home-data.js";
import { Dock, type DockRoute } from "./layout/Dock.js";
import { LayoutHost } from "./layout/LayoutHost.js";
import { panelRuntime, registerBuiltinPanels } from "./layout/builtin-panels.js";

declare global {
  interface Window {
    rakko: RakkoApi;
  }
}

// 模块加载时注册一次，之后 render 只更新 panelRuntime
registerBuiltinPanels();

/**
 * 应用外壳。
 *
 * 两套承载方式：
 *   - 首页：普通路由切换（它不需要分割/多面板）
 *   - 对话：走布局树（支持将来的分割、多面板、持久化）
 *
 * 布局树是用户级全局的，所以它只承载「工作区」这一侧。
 */
export default function App() {
  const [appInfo, setAppInfo] = useState<{ name: string; version: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<DockRoute>("home");
  const [mode, setMode] = useState<PermissionMode>("ask");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);

  const [homeRefreshKey, setHomeRefreshKey] = useState(0);
  const home = useHomeData(homeRefreshKey);

  // 把最新参数交给面板注册表 —— 注册只做一次，render 读这里
  panelRuntime.current = {
    sessionId,
    appInfo,
    mode,
    onModeChange: setMode,
    initialPrompt: pendingPrompt,
    onConsumeInitialPrompt: () => setPendingPrompt(null),
  };

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

  const startFromHome = useCallback((prompt: string) => {
    setSessionId(null);
    setPendingPrompt(prompt);
    setRoute("chat");
  }, []);

  const openSession = useCallback((id: string) => {
    setSessionId(id);
    setPendingPrompt(null);
    setRoute("chat");
  }, []);

  // 进对话页但没有会话时自动创建
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
        ) : sessionError ? (
          <div style={{ padding: 32, color: "var(--warn)" }}>
            创建会话失败：{sessionError}
          </div>
        ) : (
          /* 对话页走布局树：支持分割与持久化 */
          <LayoutHost />
        )}
      </div>
    </div>
  );
}
