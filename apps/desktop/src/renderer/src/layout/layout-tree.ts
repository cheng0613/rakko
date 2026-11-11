/**
 * 布局树 —— 递归 split / pane 结构。
 *
 * 这是从 Cindy 的设计里移植的核心不变量（见 AGENTS.md 不变量 10）：
 *
 * 1. `chat-main` 恰好一个，始终可见、不可关闭、最小宽度 400px
 * 2. 位置是用户偏好，**面板身份是 panelKind**，不能用「左栏/右栏」当业务标识
 * 3. 未注册 / 沉睡 / 已抽离的面板**保留位置但不渲染**
 * 4. 所有变换必须保持树合法 —— 非法变换直接抛错，不静默产生坏状态
 *
 * 这个文件是纯函数，不依赖 React / DOM / Electron，方便单测。
 */

export const MIN_CHAT_WIDTH = 400;
export const CHAT_PANE_KIND = "chat-main";

export type PanelKind = string;

export interface PaneNode {
  type: "pane";
  id: string;
  panelKind: PanelKind;
}

export interface SplitNode {
  type: "split";
  id: string;
  direction: "row" | "col";
  /** 第一个子节点占的比例，0 < fraction < 1 */
  fraction: number;
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = PaneNode | SplitNode;

export class LayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayoutError";
  }
}

let idCounter = 0;

/** 生成稳定、可预测的 id。测试里可重置。 */
export function nextId(prefix = "n"): string {
  idCounter += 1;
  return `${prefix}${idCounter}`;
}

export function resetIdCounter(): void {
  idCounter = 0;
}

export function pane(panelKind: PanelKind, id = nextId("p")): PaneNode {
  return { type: "pane", id, panelKind };
}

export function split(
  direction: "row" | "col",
  fraction: number,
  first: LayoutNode,
  second: LayoutNode,
  id = nextId("s"),
): SplitNode {
  if (!(fraction > 0 && fraction < 1)) {
    throw new LayoutError(`split fraction 必须在 (0,1) 开区间，实际 ${fraction}`);
  }
  return { type: "split", id, direction, fraction, first, second };
}

/** 遍历所有 pane */
export function collectPanes(node: LayoutNode): PaneNode[] {
  if (node.type === "pane") return [node];
  return [...collectPanes(node.first), ...collectPanes(node.second)];
}

/** 统计某个 panelKind 出现次数 */
export function countKind(node: LayoutNode, kind: PanelKind): number {
  return collectPanes(node).filter((p) => p.panelKind === kind).length;
}

/**
 * 校验树合法。任何一条不满足就抛错 —— 不返回 false，避免调用方忽略。
 */
export function validateTree(node: LayoutNode): void {
  const chatCount = countKind(node, CHAT_PANE_KIND);
  if (chatCount !== 1) {
    throw new LayoutError(`树里必须恰好有一个 ${CHAT_PANE_KIND}，实际 ${chatCount} 个`);
  }

  const ids = new Set<string>();
  const walk = (n: LayoutNode): void => {
    if (ids.has(n.id)) throw new LayoutError(`节点 id 重复：${n.id}`);
    ids.add(n.id);

    if (n.type === "split") {
      if (!(n.fraction > 0 && n.fraction < 1)) {
        throw new LayoutError(`split ${n.id} 的 fraction 非法：${n.fraction}`);
      }
      walk(n.first);
      walk(n.second);
    }
  };
  walk(node);
}

/** 查找指定 panelKind 的第一个 pane */
export function findPane(node: LayoutNode, panelKind: PanelKind): PaneNode | null {
  if (node.type === "pane") return node.panelKind === panelKind ? node : null;
  return findPane(node.first, panelKind) ?? findPane(node.second, panelKind);
}

/**
 * 在指定 pane 旁边插入一个新 pane。
 *
 * 新面板放在 second（右侧/下侧），原 pane 保留在 first。
 * 这是「边组」插入的基本操作。
 */
export function insertBeside(
  root: LayoutNode,
  targetPaneId: string,
  newPane: PaneNode,
  direction: "row" | "col",
  fraction = 0.5,
): LayoutNode {
  const replace = (n: LayoutNode): LayoutNode => {
    if (n.type === "pane") {
      if (n.id !== targetPaneId) return n;
      return split(direction, fraction, n, newPane);
    }
    const first = replace(n.first);
    const second = replace(n.second);
    if (first === n.first && second === n.second) return n;
    return { ...n, first, second };
  };

  const next = replace(root);
  if (next === root) {
    throw new LayoutError(`找不到 pane ${targetPaneId}，无法插入`);
  }
  validateTree(next);
  return next;
}

/**
 * 移除一个 pane，把它的兄弟节点顶上来。
 *
 * 不允许移除 chat-main —— 那是唯一的、不可关闭的。
 */
export function removePane(root: LayoutNode, paneId: string): LayoutNode {
  const target = collectPanes(root).find((p) => p.id === paneId);
  if (!target) throw new LayoutError(`找不到 pane ${paneId}`);
  if (target.panelKind === CHAT_PANE_KIND) {
    throw new LayoutError(`${CHAT_PANE_KIND} 不可移除`);
  }

  const walk = (n: LayoutNode): LayoutNode => {
    if (n.type === "pane") return n;
    if (n.first.type === "pane" && n.first.id === paneId) return n.second;
    if (n.second.type === "pane" && n.second.id === paneId) return n.first;
    return { ...n, first: walk(n.first), second: walk(n.second) };
  };

  const next = walk(root);
  validateTree(next);
  return next;
}

/** 修改 split 的比例，保持合法范围 */
export function setFraction(root: LayoutNode, splitId: string, fraction: number): LayoutNode {
  if (!(fraction > 0 && fraction < 1)) {
    throw new LayoutError(`fraction 必须在 (0,1) 开区间，实际 ${fraction}`);
  }
  const walk = (n: LayoutNode): LayoutNode => {
    if (n.type === "pane") return n;
    if (n.id === splitId) return { ...n, fraction };
    return { ...n, first: walk(n.first), second: walk(n.second) };
  };
  const next = walk(root);
  validateTree(next);
  return next;
}

/** 创建默认布局：只有 chat-main。 */
export function createDefaultLayout(): PaneNode {
  return pane(CHAT_PANE_KIND, "chat");
}

/** 序列化为 JSON（用于持久化） */
export function serialize(node: LayoutNode): string {
  return JSON.stringify(node);
}

/**
 * 反序列化。任何结构问题都抛错 —— 宁可回到默认布局，
 * 也不要让界面带着一棵半坏的树启动。
 */
export function deserialize(json: string): LayoutNode {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new LayoutError(`布局 JSON 解析失败：${(e as Error).message}`);
  }
  const node = parseNode(raw);
  validateTree(node);
  return node;
}

function parseNode(raw: unknown): LayoutNode {
  if (typeof raw !== "object" || raw === null) {
    throw new LayoutError("布局节点必须是对象");
  }
  const obj = raw as Record<string, unknown>;

  if (obj["type"] === "pane") {
    if (typeof obj["id"] !== "string" || typeof obj["panelKind"] !== "string") {
      throw new LayoutError("pane 节点需要 string 类型的 id 与 panelKind");
    }
    return { type: "pane", id: obj["id"], panelKind: obj["panelKind"] };
  }

  if (obj["type"] === "split") {
    const direction = obj["direction"];
    if (direction !== "row" && direction !== "col") {
      throw new LayoutError(`split 的 direction 必须是 row 或 col，实际 ${String(direction)}`);
    }
    const fraction = obj["fraction"];
    if (typeof fraction !== "number") {
      throw new LayoutError("split 的 fraction 必须是数字");
    }
    if (typeof obj["id"] !== "string") {
      throw new LayoutError("split 节点需要 string 类型的 id");
    }
    return {
      type: "split",
      id: obj["id"],
      direction,
      fraction,
      first: parseNode(obj["first"]),
      second: parseNode(obj["second"]),
    };
  }

  throw new LayoutError(`未知节点类型：${String(obj["type"])}`);
}
