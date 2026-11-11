import type { LayoutNode } from "./layout-tree.js";

interface Props {
  node: LayoutNode;
}

/**
 * 递归渲染布局节点。
 *
 * split 用 flex 布局，pane 是叶子。
 *
 * 注意：现在还没有面板注册表，所有 pane 都渲染成占位。
 * 接入注册表后，未注册的 panelKind 要「保留位置但不渲染」
 * —— 见 AGENTS.md 不变量说明。
 */
export function LayoutPane({ node }: Props) {
  if (node.type === "pane") {
    return <PaneLeaf panelKind={node.panelKind} paneId={node.id} />;
  }

  const isRow = node.direction === "row";
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
          minWidth: 0,
          minHeight: 0,
          display: "flex",
        }}
      >
        <LayoutPane node={node.first} />
      </div>
      <div
        style={{
          flex: `${1 - node.fraction} 1 0`,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
        }}
      >
        <LayoutPane node={node.second} />
      </div>
    </div>
  );
}

function PaneLeaf({ panelKind, paneId }: { panelKind: string; paneId: string }) {
  return (
    <section
      data-panel-kind={panelKind}
      data-pane-id={paneId}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        padding: 24,
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius)",
        margin: 12,
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div
        style={{
          fontSize: 12,
          color: "var(--ink3)",
          textTransform: "uppercase",
          letterSpacing: ".08em",
        }}
      >
        {panelKind}
      </div>
      <div
        style={{
          flex: 1,
          display: "grid",
          placeItems: "center",
          color: "var(--ink3)",
          fontSize: 13,
          textAlign: "center",
        }}
      >
        <div>
          <p>对话区待接入（P0 步骤 9）</p>
          <p style={{ marginTop: 6, fontSize: 12 }}>
            下一步：用 OpenDesign 的对话页设计稿落地
          </p>
        </div>
      </div>
    </section>
  );
}
