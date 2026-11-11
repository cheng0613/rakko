import { beforeEach, describe, expect, it } from "vitest";
import {
  CHAT_PANE_KIND,
  type LayoutNode,
  LayoutError,
  MIN_CHAT_WIDTH,
  collectPanes,
  countKind,
  createDefaultLayout,
  deserialize,
  findPane,
  insertBeside,
  nextId,
  pane,
  removePane,
  resetIdCounter,
  serialize,
  setFraction,
  split,
  validateTree,
} from "../layout-tree.js";

beforeEach(() => {
  resetIdCounter();
});

describe("不变量：chat-main 恰好一个", () => {
  it("默认布局有且只有一个 chat-main", () => {
    const root = createDefaultLayout();
    expect(countKind(root, CHAT_PANE_KIND)).toBe(1);
    expect(() => validateTree(root)).not.toThrow();
  });

  it("两个 chat-main 必须被拒绝", () => {
    const root = split("row", 0.5, pane(CHAT_PANE_KIND), pane(CHAT_PANE_KIND));
    expect(() => validateTree(root)).toThrow(LayoutError);
    expect(() => validateTree(root)).toThrow(/恰好有一个/);
  });

  it("没有 chat-main 的树必须被拒绝", () => {
    const root = split("row", 0.5, pane("files"), pane("terminal"));
    expect(() => validateTree(root)).toThrow(/恰好有一个/);
  });

  it("chat-main 不可移除", () => {
    const root = createDefaultLayout();
    expect(() => removePane(root, root.id)).toThrow(/不可移除/);
  });
});

describe("不变量：面板身份用 panelKind，不是位置", () => {
  it("插入到右侧后 panelKind 不变", () => {
    let root: LayoutNode = createDefaultLayout();
    const chat = findPane(root, CHAT_PANE_KIND);
    expect(chat).not.toBeNull();

    root = insertBeside(root, chat!.id, pane("files"), "row");
    expect(findPane(root, "files")).not.toBeNull();
    // chat-main 仍存在，且只有 1 个
    expect(countKind(root, CHAT_PANE_KIND)).toBe(1);
  });

  it("左右位置调换不影响 panelKind 识别", () => {
    const a = split("row", 0.3, pane("files"), pane(CHAT_PANE_KIND));
    const b = split("row", 0.7, pane(CHAT_PANE_KIND), pane("files"));
    expect(findPane(a, CHAT_PANE_KIND)).not.toBeNull();
    expect(findPane(b, CHAT_PANE_KIND)).not.toBeNull();
    expect(findPane(a, "files")).not.toBeNull();
    expect(findPane(b, "files")).not.toBeNull();
  });
});

describe("不变量：树变换必须保持合法", () => {
  it("非法 fraction 必须抛错", () => {
    expect(() => split("row", 0, pane("a"), pane("b"))).toThrow(LayoutError);
    expect(() => split("row", 1, pane("a"), pane("b"))).toThrow(LayoutError);
    expect(() => split("row", -0.1, pane("a"), pane("b"))).toThrow(LayoutError);
    expect(() => split("row", 1.5, pane("a"), pane("b"))).toThrow(LayoutError);
  });

  it("setFraction 拒绝越界值", () => {
    const root = split("row", 0.5, pane(CHAT_PANE_KIND), pane("files"), "s1");
    expect(() => setFraction(root, "s1", 0)).toThrow(LayoutError);
    expect(() => setFraction(root, "s1", 1)).toThrow(LayoutError);
    expect(() => setFraction(root, "s1", 0.3)).not.toThrow();
  });

  it("插入不存在的 pane 抛错", () => {
    const root = createDefaultLayout();
    expect(() => insertBeside(root, "no-such-id", pane("files"), "row")).toThrow(/找不到/);
  });

  it("节点 id 重复必须被拒绝", () => {
    const root = split("row", 0.5, pane(CHAT_PANE_KIND, "dup"), pane("files", "dup"), "s1");
    expect(() => validateTree(root)).toThrow(/id 重复/);
  });
});

describe("插入与移除", () => {
  it("插入后可移除，回到原状", () => {
    let root: LayoutNode = createDefaultLayout();
    const chat = findPane(root, CHAT_PANE_KIND)!;
    root = insertBeside(root, chat.id, pane("files", "f1"), "row");
    expect(collectPanes(root)).toHaveLength(2);

    root = removePane(root, "f1");
    expect(collectPanes(root)).toHaveLength(1);
    expect(countKind(root, CHAT_PANE_KIND)).toBe(1);
    expect(() => validateTree(root)).not.toThrow();
  });

  it("多层嵌套插入后仍是合法树", () => {
    let root: LayoutNode = createDefaultLayout();
    const chat = findPane(root, CHAT_PANE_KIND)!;
    root = insertBeside(root, chat.id, pane("files", "f1"), "row");
    root = insertBeside(root, "f1", pane("terminal", "t1"), "col");
    root = insertBeside(root, "t1", pane("review", "r1"), "col");

    expect(collectPanes(root)).toHaveLength(4);
    expect(() => validateTree(root)).not.toThrow();
  });

  it("移除中间的 pane 时兄弟节点顶上来", () => {
    let root: LayoutNode = createDefaultLayout();
    const chat = findPane(root, CHAT_PANE_KIND)!;
    root = insertBeside(root, chat.id, pane("files", "f1"), "row");
    root = insertBeside(root, "f1", pane("terminal", "t1"), "row");

    root = removePane(root, "f1");
    expect(collectPanes(root)).toHaveLength(2);
    expect(findPane(root, "terminal")).not.toBeNull();
    expect(findPane(root, CHAT_PANE_KIND)).not.toBeNull();
  });
});

describe("序列化往返", () => {
  it("序列化再反序列化得到等价的树", () => {
    let root: LayoutNode = createDefaultLayout();
    const chat = findPane(root, CHAT_PANE_KIND)!;
    root = insertBeside(root, chat.id, pane("files", "f1"), "row", 0.7);

    const json = serialize(root);
    const back = deserialize(json);
    expect(back).toEqual(root);
    expect(() => validateTree(back)).not.toThrow();
  });

  it("坏 JSON 抛错，不返回默认布局（避免掩盖问题）", () => {
    expect(() => deserialize("{not json")).toThrow(LayoutError);
  });

  it("结构不对抛错", () => {
    expect(() => deserialize("{}")).toThrow(LayoutError);
    expect(() => deserialize('{"type":"pane"}')).toThrow(LayoutError);
    expect(() => deserialize('{"type":"split","id":"s1","direction":"diag","fraction":0.5}')).toThrow(
      /direction/,
    );
  });

  it("反序列化时也跑 validateTree —— 两个 chat-main 会被拒", () => {
    const bad = JSON.stringify(
      split("row", 0.5, pane(CHAT_PANE_KIND, "a"), pane(CHAT_PANE_KIND, "b"), "s1"),
    );
    expect(() => deserialize(bad)).toThrow(/恰好有一个/);
  });
});

describe("常量", () => {
  it("最小聊天宽度是 400px", () => {
    expect(MIN_CHAT_WIDTH).toBe(400);
  });

  it("nextId 递增且不重复", () => {
    const ids = new Set([nextId(), nextId(), nextId()]);
    expect(ids.size).toBe(3);
  });
});
