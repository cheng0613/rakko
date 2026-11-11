import { useMemo, useState } from "react";
import { PRODUCT_NAME } from "@rakko/shared";
import type { HomeSession } from "./use-home-data.js";
import "./home.css";

export interface HomeTask {
  id: string;
  title: string;
  status: "urgent" | "doing" | "todo";
  due?: string;
  done?: boolean;
}

export interface HomeProps {
  appInfo: { name: string; version: string } | null;
  userName?: string;
  /** 真实会话（来自数据库） */
  sessions?: HomeSession[];
  lastSession?: HomeSession | null;
  loading?: boolean;
  error?: string | null;
  /** 点建议任务或输入框 → 新开一个会话并带上这句话 */
  onStartTask?: (prompt: string) => void;
  onSubmit?: (text: string) => void;
  /** 点历史会话 → 打开它 */
  onOpenSession?: (sessionId: string) => void;
  permissionLabel?: string;
  onCyclePermission?: () => void;
}

const STATUS_PILL: Record<HomeTask["status"], { cls: string; text: string }> = {
  urgent: { cls: "red", text: "紧急" },
  doing: { cls: "blu", text: "进行中" },
  todo: { cls: "gray", text: "待办" },
};

const DOT_COLOR: Record<HomeTask["status"], string> = {
  urgent: "#e03131",
  doing: "#4dabf7",
  todo: "var(--line2)",
};

/**
 * 首页 · 启动台。
 *
 * 规格来自 OpenDesign 稿件。数据来自本地数据库：
 *   - 「我的任务」= 最近会话列表（每个会话就是一个任务）
 *   - 「上次会话」= 最近一条会话
 *   - 「最近打开的文件」= **还没有数据源**，保持空状态，不伪造
 */
export function HomePage({
  appInfo,
  userName,
  sessions = [],
  lastSession = null,
  loading = false,
  error = null,
  onStartTask,
  onSubmit,
  onOpenSession,
  permissionLabel,
  onCyclePermission,
}: HomeProps) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");

  const visibleSessions = useMemo(() => {
    if (!query.trim()) return sessions;
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => s.title.toLowerCase().includes(q));
  }, [sessions, query]);

  const submit = (): void => {
    const text = input.trim();
    if (!text || !onSubmit) return;
    setInput("");
    onSubmit(text);
  };

  return (
    <div className="home-page">
      <header className="titlebar">
        <span className="logo" aria-hidden>
          π
        </span>
        <span className="tname">{appInfo?.name ?? PRODUCT_NAME}</span>
        <span className="meta">{appInfo ? `v${appInfo.version}` : ""}</span>
        <span className="spacer" />
        {loading && <span className="meta">加载中…</span>}
      </header>

      <div className="home-scroll">
        <div className="hm-hello">
          <span className="mark">{userName ? `欢迎回来，${userName}` : "你好"}</span>
          <span className="sub">今天想让 Agent 做点什么？</span>
        </div>

        {error && (
          <div className="hm-error">
            读取历史失败：{error}
          </div>
        )}

        <div className="hm-row">
          <div className="hm-card tint">
            <h6>最近打开的文件</h6>
            <div className="home-empty">
              还没有追踪文件访问。这一块需要记录 Agent 读过哪些文件，属于后续功能。
            </div>
          </div>

          <div className="hm-card">
            <h6>上次会话</h6>
            {lastSession ? (
              <div
                className="meet clickable"
                onClick={() => onOpenSession?.(lastSession.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onOpenSession?.(lastSession.id);
                }}
              >
                <span className="ava" />
                <span>
                  <b>{lastSession.title}</b>
                  <small>{lastSession.relativeTime}</small>
                </span>
              </div>
            ) : (
              <div className="home-empty">
                还没有历史会话。开始第一次对话后，这里会显示上次聊到哪。
              </div>
            )}
          </div>
        </div>

        <div className="hm-row">
          <button
            className="hm-card sugg"
            onClick={() => onStartTask?.("读一下当前目录，告诉我这是什么项目")}
            disabled={!onStartTask}
          >
            <span className="sg">建议任务</span>
            <b>读一下当前目录，告诉我这是什么项目</b>
          </button>
          <button
            className="hm-card sugg"
            onClick={() => onStartTask?.("帮我看看当前目录下有哪些文件，简单介绍一下")}
            disabled={!onStartTask}
          >
            <span className="sg">建议任务</span>
            <b>帮我看看当前目录下有哪些文件</b>
          </button>
        </div>

        <div className="hm-tasks">
          <div className="hm-th">
            <b>我的任务</b>
            <span className="cnt">{visibleSessions.length}</span>
            <span className="hm-search">
              <span aria-hidden>⌕</span>
              <input
                placeholder="搜索任务…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </span>
          </div>

          {visibleSessions.length === 0 ? (
            <div className="home-empty">
              {query
                ? "没有匹配的任务。"
                : "还没有任务。每个会话就是一个任务，开始对话后会出现在这里。"}
            </div>
          ) : (
            visibleSessions.map((s) => (
              <div className="trow" key={s.id}>
                <span className="tdot" style={{ background: DOT_COLOR.todo }} />
                <span className="tname" onClick={() => onOpenSession?.(s.id)}>
                  {s.title}
                </span>
                <span className="sp" />
                <span className="pill gray">{s.relativeTime}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="composer">
        <div className="cbar">
          {permissionLabel && (
            <button className="ppill" onClick={onCyclePermission} title="切换权限档">
              {permissionLabel}
            </button>
          )}
          <input
            className="cinput"
            placeholder="问任何问题…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button
            className="csend"
            onClick={submit}
            disabled={input.trim().length === 0 || !onSubmit}
            title="发送"
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}
