/**
 * 面板注册表。
 *
 * 布局树只记 `panelKind` 字符串，具体渲染什么由这里决定。
 * 这是 AGENTS.md 里那条不变量的落点：
 *   「面板身份用 panelKind，不能用『左栏/右栏』当业务标识」
 *
 * 未注册的 panelKind：**保留位置但不渲染**（不是删掉）。
 * 这样扩展卸载、面板暂时不可用时，用户回来还能看到原位置。
 */
import type { JSX } from "react";

export interface PanelRenderProps {
  paneId: string;
  /** 面板被激活（点击或获得焦点） */
  active: boolean;
}

export interface PanelDescriptor {
  kind: string;
  /** 显示名，用在页签与标题 */
  title: string;
  /** 渲染函数。返回 null 表示该面板当前无可渲染内容（保留占位） */
  render: (props: PanelRenderProps) => JSX.Element | null;
  /** 是否可关闭。`chat-main` 不可关闭 */
  closable: boolean;
  /** 是否可折叠 */
  collapsible: boolean;
}

const registry = new Map<string, PanelDescriptor>();

export function registerPanel(descriptor: PanelDescriptor): void {
  if (registry.has(descriptor.kind)) {
    throw new Error(`面板 kind 重复注册：${descriptor.kind}`);
  }
  registry.set(descriptor.kind, descriptor);
}

export function getPanel(kind: string): PanelDescriptor | undefined {
  return registry.get(kind);
}

export function listPanels(): PanelDescriptor[] {
  return [...registry.values()];
}

/** 测试用：清空注册表 */
export function resetRegistry(): void {
  registry.clear();
}
