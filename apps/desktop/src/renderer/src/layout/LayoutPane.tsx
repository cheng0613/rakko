import type { LayoutNode } from "./layout-tree.js";
import { MIN_CHAT_WIDTH } from "./layout-tree.js";
import { getPanel } from "./panel-registry.js";

interface Props {
  node: LayoutNode;
  /** 当前激活的 pane id */
  activePaneId: string | null;
  onActivate?: (paneId: string) => void;
}

/**
 * 递归渲染布局节点。
 *
 * split 用 flex 布局，pane 是叶子。
 *
 * 未注册的 panelKind：保留位置、显示占位，**不渲染内容也不删除**。
 * 这是为了扩展卸载/面板暂时不可用时，用户回来还能看到原位置。
 */
export function LayoutPane({ node, activePaneId, onActivate }: Props) {
  if (node.type === "pane") {
    return (
      <PaneLeaf
        panelKind={node.panelKind}
        paneId={node.id}
        active={activePaneId === node.id}
        onActivate={onActivate}
      />
    );
  }

  const isRow = node.direction === "row";

  // chat-main 所在的那一侧不能小于最小宽度。
  // row 布局时约束宽度，col 布局时不约束（高度没有下限）
  const minSize = isRow ? MIN_CHAT_WIDTH : 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: isRow ? "row" : "column",
        flex: 1,
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <div
        style={{
          flex: `${node.fraction} 1 0`,
          minWidth: isRow ? minSize : 0,
          minHeight: 0,
          display: "flex",
          overflow: "hidden",
        }}
      >
        <LayoutPane node={node.first} activePaneId={activePaneId} onActivate={onActivate} />
      </div>
      <div
        style={{
          flex: `${1 - node.fraction} 1 0`,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          overflow: "hidden",
        }}
      >
        <LayoutPane node={node.second} activePaneId={activePaneId} onActivate={onActivate} />
      </div>
    </div>
  );
}

function PaneLeaf({
  panelKind,
  paneId,
  active,
  onActivate,
}: {
  panelKind: string;
  paneId: string;
  active: boolean;
  onActivate?: (paneId: string) => void;
}) {
  const descriptor = getPanel(panelKind);

  // 未注册：保留位置，显示占位
  if (!descriptor) {
    return (
      <section
        data-panel-kind={panelKind}
        data-pane-id={paneId}
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: "grid",
          placeItems: "center",
          color: "var(--ink3)",
          fontSize: 12,
          background: "var(--card2)",
          border: "1px dashed var(--line2)",
          borderRadius: 10,
          margin: 8,
        }}
      >
        面板「{panelKind}」未注册
      </section>
    );
  }

  const content = descriptor.render({ paneId, active });

  return (
    <section
      data-panel-kind={panelKind}
      data-pane-id={paneId}
      onMouseDown={() => onActivate?.(paneId)}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {content ?? (
        <div
          style={{
            flex: 1,
            display: "grid",
            placeItems: "center",
            color: "var(--ink3)",
            fontSize: 12,
          }}
        >
          {descriptor.title} 暂无内容
        </div>
      )}
    </section>
  );
}
