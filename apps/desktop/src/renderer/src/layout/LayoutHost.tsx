import { useCallback, useEffect, useRef, useState } from "react";
import type { LayoutNode } from "./layout-tree.js";
import { CHAT_PANE_KIND, countKind, validateTree } from "./layout-tree.js";
import { LayoutPane } from "./LayoutPane.js";
import { loadLayout, saveLayout } from "./persistence.js";
import { getPanel } from "./panel-registry.js";

/**
 * 布局宿主。
 *
 * 职责：
 *   1. 首帧就渲染保存的布局（不先画默认再跳变）
 *   2. 布局变化时存盘
 *   3. 存盘读不出来时回落默认，不阻塞启动
 *
 * 现在只有一个 pane（chat-main），但结构已经支持 split：
 * 加面板只要 insertBeside，不需要改这里。
 */
export function LayoutHost() {
  // 首帧就用保存的布局 —— 避免先画默认再跳变
  const [layout, setLayout] = useState<LayoutNode>(() => loadLayout().layout);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [saveWarned, setSaveWarned] = useState(false);

  // 布局**变化**时存盘。
  // 用 ref 跳过首次挂载 —— 否则每次打开对话页都把刚读出来的布局再写一遍，
  // 既无意义，也会掩盖「存盘被外部改动」的情况。
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    const ok = saveLayout(layout);
    if (!ok && !saveWarned) {
      setSaveWarned(true);
      console.warn("[layout] 布局无法保存，本次会话内的调整重启后会丢失");
    }
  }, [layout, saveWarned]);

  /** 统一入口：改布局前先校验，非法就拒绝（避免产生坏状态） */
  const updateLayout = useCallback((next: LayoutNode) => {
    try {
      validateTree(next);
      setLayout(next);
    } catch (e) {
      console.error("[layout] 拒绝非法布局变换：", (e as Error).message);
    }
  }, []);

  const chatCount = countKind(layout, CHAT_PANE_KIND);

  return (
    <div className="layout-host">
      <main className="layout-main">
        <LayoutPane node={layout} activePaneId={activePaneId} onActivate={setActivePaneId} />
      </main>
    </div>
  );
}

/** 供调试：把当前布局打印出来 */
export function describeLayout(node: LayoutNode): string {
  if (node.type === "pane") {
    const p = getPanel(node.panelKind);
    return p ? `${node.panelKind}(${node.id})` : `${node.panelKind}?(${node.id})`;
  }
  return `${node.direction}[${describeLayout(node.first)} | ${describeLayout(node.second)}]`;
}
