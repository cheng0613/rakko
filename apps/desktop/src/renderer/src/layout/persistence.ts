/**
 * 布局持久化。
 *
 * 分两段：
 *   - 浏览器（renderer）：localStorage，简单直接
 *   - 将来多端同步：换成走 IPC 到主进程的 LayoutStore
 *
 * 三条原则（来自 AGENTS.md「把用户的选择与系统演进分开」）：
 *   1. 存的是**用户的选择**，默认值随产品演进
 *   2. 读不出来就用默认布局，**不要因为布局坏了让应用起不来**
 *   3. 存盘失败不打扰用户（console 记一笔就够）
 */
import {
  createDefaultLayout,
  deserialize,
  serialize,
  type LayoutNode,
} from "./layout-tree.js";

const STORAGE_KEY = "rakko.layout.v1";

export interface LoadResult {
  layout: LayoutNode;
  /** 是不是用了默认布局（存盘不存在 / 坏了 / 版本不符） */
  fallback: boolean;
  /** fallback 时的原因，用于诊断 */
  reason?: string;
}

function getStorage(): Storage | null {
  try {
    // 某些环境下 localStorage 存在但访问会抛（隐私模式）
    const s = globalThis.localStorage;
    if (!s) return null;
    const probe = "__rakko_probe__";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

/**
 * 读取保存的布局。
 *
 * 任何问题都回落默认布局，绝不抛错 —— 界面必须能起来。
 */
export function loadLayout(): LoadResult {
  const storage = getStorage();
  if (!storage) {
    return { layout: createDefaultLayout(), fallback: true, reason: "localStorage 不可用" };
  }

  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch (e) {
    return {
      layout: createDefaultLayout(),
      fallback: true,
      reason: `读取失败：${(e as Error).message}`,
    };
  }

  if (!raw) {
    return { layout: createDefaultLayout(), fallback: true, reason: "没有保存过布局" };
  }

  try {
    // deserialize 内部会跑 validateTree；结构不对会抛
    const layout = deserialize(raw);
    return { layout, fallback: false };
  } catch (e) {
    // 存盘坏了：保留坏数据（便于排查）但用默认布局
    console.warn("[layout] 保存的布局无法解析，已回落默认：", (e as Error).message);
    return {
      layout: createDefaultLayout(),
      fallback: true,
      reason: `解析失败：${(e as Error).message}`,
    };
  }
}

/** 保存布局。失败只记日志，不抛。 */
export function saveLayout(layout: LayoutNode): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, serialize(layout));
    return true;
  } catch (e) {
    console.warn("[layout] 保存布局失败：", (e as Error).message);
    return false;
  }
}

/** 清掉保存的布局（恢复默认） */
export function clearLayout(): void {
  try {
    getStorage()?.removeItem(STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
}
