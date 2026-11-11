import { useState } from "react";
import type { LayoutNode } from "./layout-tree.js";
import { createDefaultLayout, countKind, CHAT_PANE_KIND } from "./layout-tree.js";
import { LayoutPane } from "./LayoutPane.js";

interface Props {
  appInfo: { name: string; version: string } | null;
}

/**
 * 布局宿主：把布局树渲染成界面。
 *
 * 现在是单 pane（只有 chat-main）。P0 后续步骤会：
 * - 接上 split 的递归渲染与拖拽分割
 * - 接上持久化（重启保持）
 * - 接上面板注册表（未注册的 panelKind 保留位置但不渲染）
 */
export function LayoutHost({ appInfo }: Props) {
  const [layout] = useState<LayoutNode>(() => createDefaultLayout());

  const chatCount = countKind(layout, CHAT_PANE_KIND);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--canvas)",
      }}
    >
      {/* 顶部标题栏 */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 16px",
          borderBottom: "1px solid var(--line)",
          background: "var(--card)",
          flex: "none",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            background: "var(--acid)",
            border: "1px solid var(--acid-line)",
            display: "grid",
            placeItems: "center",
            fontSize: 13,
            fontWeight: 700,
          }}
        >
          π
        </span>
        <strong style={{ fontSize: 14 }}>{appInfo?.name ?? "Rakko"}</strong>
        <span style={{ color: "var(--ink3)", fontSize: 12 }}>
          {appInfo ? `v${appInfo.version}` : "连接中…"}
        </span>
        <span style={{ flex: 1 }} />
        <span
          className="mono"
          style={{ color: "var(--ink3)", fontSize: 11 }}
          title="布局树状态"
        >
          panes: {countKind(layout, CHAT_PANE_KIND)} chat
        </span>
      </header>

      {/* 布局区 */}
      <main style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <LayoutPane node={layout} />
      </main>

      {/* 底部状态栏 */}
      <footer
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "6px 16px",
          borderTop: "1px solid var(--line)",
          background: "var(--card2)",
          color: "var(--ink3)",
          fontSize: 11,
          flex: "none",
        }}
      >
        <span>chat-main: {chatCount === 1 ? "✓ 恰好一个" : `✗ ${chatCount} 个`}</span>
        <span>P0 骨架 · 布局树已就绪</span>
      </footer>
    </div>
  );
}
