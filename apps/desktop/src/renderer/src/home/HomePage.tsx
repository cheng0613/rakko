import { useMemo, useState } from "react";
import { PRODUCT_NAME } from "@rakko/shared";
import "./home.css";

export interface HomeTask {
  id: string;
  title: string;
  status: "urgent" | "doing" | "todo";
  due?: string;
  /** 已完成的不显示在列表里 */
  done?: boolean;
}

export interface HomeProps {
  appInfo: { name: string; version: string } | null;
  userName?: string;
  tasks?: HomeTask[];
  /** 最近打开的文件（P0 先用项目里的真实入口） */
  recentFiles?: Array<{ name: string; kind: "m" | "f" | "p" }>;
  /** 点击建议任务或任务行，带着文本进对话 */
  onStartTask?: (prompt: string) => void;
  /** 直接输入后发送 */
  onSubmit?: (text: string) => void;
  /** 权限档 pill 点一下循环切换 */
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
 * 规格来自 OpenDesign 稿件：问候 + 最近文件 + 上次会话 + 建议任务 + 任务列表 + composer。
 *
 * P0 阶段的数据都还是空的（没有项目持久化、没有任务表），
 * 所以每个区块都要有诚实的空状态，不能塞假数据。
 */
export function HomePage({
  appInfo,
  userName,
  tasks = [],
  recentFiles = [],
  onStartTask,
  onSubmit,
  permissionLabel,
  onCyclePermission,
}: HomeProps) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");

  const visibleTasks = useMemo(() => {
    const list = tasks.filter((t) => !t.done);
    if (!query.trim()) return list;
    const q = query.trim().toLowerCase();
    return list.filter((t) => t.title.toLowerCase().includes(q));
  }, [tasks, query]);

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
      </header>

      <div className="home-scroll">
        <div className="hm-hello">
          {userName ? (
            <>
              <span className="mark">欢迎回来，{userName}</span>
              <span className="sub">今天想让 Agent 做点什么？</span>
            </>
          ) : (
            <>
              <span className="mark">你好</span>
              <span className="sub">今天想让 Agent 做点什么？</span>
            </>
          )}
        </div>

        <div className="hm-row">
          <div className="hm-card tint">
            <h6>最近打开的文件</h6>
            {recentFiles.length === 0 ? (
              <div className="home-empty">还没有打开过文件。在对话里让它读某个文件后，这里会列出来。</div>
            ) : (
              recentFiles.map((f) => (
                <div className="filerow" key={f.name}>
                  <span className={`fico ${f.kind}`}>{f.kind === "p" ? "PDF" : f.kind.toUpperCase()}</span>
                  <span>{f.name}</span>
                </div>
              ))
            )}
          </div>

          <div className="hm-card">
            <h6>上次会话</h6>
            <div className="home-empty">
              还没有历史会话。开始第一次对话后，这里会显示上次聊到哪。
            </div>
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
            <span className="cnt">{visibleTasks.length}</span>
            <span className="hm-search">
              <span aria-hidden>⌕</span>
              <input
                placeholder="搜索任务…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </span>
            {visibleTasks.length > 1 && (
              <button className="prio" title="P0 暂未实现排序">✦ 按优先级排序</button>
            )}
          </div>

          {visibleTasks.length === 0 ? (
            <div className="home-empty">
              {query
                ? "没有匹配的任务。"
                : "还没有任务。每个会话就是一个任务，开始对话后会出现在这里。"}
            </div>
          ) : (
            visibleTasks.map((t) => {
              const pill = STATUS_PILL[t.status];
              return (
                <div className="trow" key={t.id}>
                  <span className="tdot" style={{ background: DOT_COLOR[t.status] }} />
                  <span className="tname" onClick={() => onStartTask?.(t.title)}>
                    {t.title}
                  </span>
                  <span className={`pill ${pill.cls}`}>{pill.text}</span>
                  {t.due && <span className="pill yel">{t.due}</span>}
                </div>
              );
            })
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
