/**
 * 首页数据。
 *
 * 从持久化层读真实会话，映射成首页需要的形状。
 *
 * 一件事要如实：**「最近打开的文件」还没有数据源**。
 * 我们没有追踪文件读取记录，所以这一块暂时保持空状态，
 * 不拿会话标题伪造。
 */
import { useCallback, useEffect, useState } from "react";
import type { RakkoApi, SessionInfo } from "@rakko/shared";

declare global {
  interface Window {
    rakko: RakkoApi;
  }
}

export interface HomeSession {
  id: string;
  title: string;
  /** 最后活动时间，用于排序与显示 */
  updatedAt: number;
  /** 相对时间，如「3 分钟前」 */
  relativeTime: string;
  projectId: string;
}

export interface HomeData {
  loading: boolean;
  error: string | null;
  sessions: HomeSession[];
  /** 上次会话（用于「上次会话」卡片） */
  lastSession: HomeSession | null;
}

/** 相对时间。避免引入 dayjs 之类的依赖 */
export function formatRelative(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day === 1) return "昨天";
  if (day < 30) return `${day} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function toHomeSession(s: SessionInfo, now: number): HomeSession {
  return {
    id: s.id,
    title: s.title,
    updatedAt: s.updatedAt,
    relativeTime: formatRelative(s.updatedAt, now),
    projectId: s.projectId,
  };
}

export function useHomeData(refreshKey = 0): HomeData & { reload: () => void } {
  const [state, setState] = useState<HomeData>({
    loading: true,
    error: null,
    sessions: [],
    lastSession: null,
  });
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (!window.rakko) throw new Error("preload 桥没接通");
        const list = await window.rakko.listRecentSessions(20);
        if (cancelled) return;

        const now = Date.now();
        const sessions = list.map((s) => toHomeSession(s, now));

        setState({
          loading: false,
          error: null,
          sessions,
          lastSession: sessions[0] ?? null,
        });
      } catch (e) {
        if (cancelled) return;
        setState({
          loading: false,
          error: e instanceof Error ? e.message : String(e),
          sessions: [],
          lastSession: null,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshKey, tick]);

  return { ...state, reload };
}
