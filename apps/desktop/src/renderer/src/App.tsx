import { useEffect, useState } from "react";
import type { RakkoApi } from "@rakko/shared";
import { LayoutHost } from "./layout/LayoutHost.js";

declare global {
  interface Window {
    rakko: RakkoApi;
  }
}

/**
 * 应用外壳。
 *
 * P0 阶段只验证三件事：
 * 1. preload 桥通了（能拿到 appInfo）
 * 2. 布局树能渲染
 * 3. 重启后布局能恢复（下一步接持久化）
 */
export default function App() {
  const [appInfo, setAppInfo] = useState<{ name: string; version: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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

  if (error) {
    return (
      <div style={{ padding: 32 }}>
        <h2 style={{ color: "var(--warn)" }}>启动失败</h2>
        <p className="mono" style={{ marginTop: 8, color: "var(--ink2)" }}>
          {error}
        </p>
        <p style={{ marginTop: 16, color: "var(--ink3)", fontSize: 13 }}>
          preload 桥没接通，检查 contextIsolation 与 preload 路径。
        </p>
      </div>
    );
  }

  return <LayoutHost appInfo={appInfo} />;
}
