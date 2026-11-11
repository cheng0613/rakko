import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_PANE_KIND, countKind, createDefaultLayout } from "../layout-tree.js";
import { clearLayout, loadLayout, saveLayout } from "../persistence.js";

/** 极简 localStorage 替身 —— 测试环境（node）没有真的 localStorage */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("保存与读取", () => {
  it("存进去再读出来是同一棵树", () => {
    const layout = createDefaultLayout();
    expect(saveLayout(layout)).toBe(true);

    const loaded = loadLayout();
    expect(loaded.fallback).toBe(false);
    expect(loaded.layout).toEqual(layout);
  });

  it("没存过时回落默认布局", () => {
    const loaded = loadLayout();
    expect(loaded.fallback).toBe(true);
    expect(loaded.reason).toContain("没有保存");
    expect(countKind(loaded.layout, CHAT_PANE_KIND)).toBe(1);
  });

  it("清掉后回到默认", () => {
    saveLayout(createDefaultLayout());
    clearLayout();
    expect(loadLayout().fallback).toBe(true);
  });
});

describe("坏数据不能让应用起不来", () => {
  it("坏 JSON 回落默认布局，不抛错", () => {
    storage.setItem("rakko.layout.v1", "{not json");
    const loaded = loadLayout();
    expect(loaded.fallback).toBe(true);
    expect(loaded.reason).toContain("解析失败");
    expect(countKind(loaded.layout, CHAT_PANE_KIND)).toBe(1);
  });

  it("结构不对（两个 chat-main）回落默认", () => {
    // 这是一棵违反不变量的树
    storage.setItem(
      "rakko.layout.v1",
      JSON.stringify({
        type: "split",
        id: "s1",
        direction: "row",
        fraction: 0.5,
        first: { type: "pane", id: "a", panelKind: CHAT_PANE_KIND },
        second: { type: "pane", id: "b", panelKind: CHAT_PANE_KIND },
      }),
    );
    const loaded = loadLayout();
    expect(loaded.fallback).toBe(true);
    // 回落后的树必须是合法的
    expect(countKind(loaded.layout, CHAT_PANE_KIND)).toBe(1);
  });

  it("未知节点类型回落默认", () => {
    storage.setItem("rakko.layout.v1", JSON.stringify({ type: "mystery", id: "x" }));
    expect(loadLayout().fallback).toBe(true);
  });
});

describe("localStorage 不可用时", () => {
  it("读：返回默认布局并说明原因", () => {
    vi.stubGlobal("localStorage", undefined);
    const loaded = loadLayout();
    expect(loaded.fallback).toBe(true);
    expect(loaded.reason).toContain("不可用");
  });

  it("写：返回 false，不抛错", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(saveLayout(createDefaultLayout())).toBe(false);
  });

  it("访问会抛的实现也不会让读崩掉", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(() => loadLayout()).not.toThrow();
    expect(loadLayout().fallback).toBe(true);
    expect(() => saveLayout(createDefaultLayout())).not.toThrow();
  });
});
