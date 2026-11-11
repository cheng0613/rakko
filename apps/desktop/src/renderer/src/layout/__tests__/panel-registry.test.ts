import { beforeEach, describe, expect, it } from "vitest";
import {
  getPanel,
  listPanels,
  registerPanel,
  resetRegistry,
} from "../panel-registry.js";
import { CHAT_PANE_KIND } from "../layout-tree.js";

beforeEach(() => {
  resetRegistry();
});

describe("面板注册表", () => {
  it("注册后能查到", () => {
    registerPanel({
      kind: "demo",
      title: "演示",
      closable: true,
      collapsible: true,
      render: () => null,
    });
    expect(getPanel("demo")?.title).toBe("演示");
  });

  it("未注册的 kind 返回 undefined（不是抛错）", () => {
    expect(getPanel("no-such")).toBeUndefined();
  });

  it("重复注册同一个 kind 会抛错（早失败好过悄悄覆盖）", () => {
    const d = {
      kind: "dup",
      title: "x",
      closable: true,
      collapsible: true,
      render: () => null,
    };
    registerPanel(d);
    expect(() => registerPanel(d)).toThrow(/重复注册/);
  });

  it("listPanels 返回全部已注册", () => {
    for (const k of ["a", "b", "c"]) {
      registerPanel({ kind: k, title: k, closable: true, collapsible: true, render: () => null });
    }
    expect(listPanels().map((p) => p.kind).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("chat-main 的约束", () => {
  it("chat-main 必须声明为不可关闭", () => {
    registerPanel({
      kind: CHAT_PANE_KIND,
      title: "对话",
      closable: false,
      collapsible: false,
      render: () => null,
    });
    const chat = getPanel(CHAT_PANE_KIND);
    expect(chat?.closable).toBe(false);
    expect(chat?.collapsible).toBe(false);
  });
});
