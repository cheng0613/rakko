/**
 * 「选择模型」弹窗。
 *
 * 设计稿给了三态，这里都实现：
 *   - 加载中：骨架屏
 *   - 成功：可勾选的模型列表（搜索 / 全选 / 清空），已在列表里的标「已在列表中」
 *   - 失败：说明 + 手动填模型 ID 的出口（很多自建网关不实现 GET /v1/models）
 */
import { useMemo, useState } from "react";

export type PickPhase = "loading" | "list" | "error";

interface Props {
  /** 上游地址，只用来显示 */
  source: string;
  phase: PickPhase;
  /** phase=list 时的候选 id */
  candidates: string[];
  /** phase=error 时的说明 */
  error: string | null;
  /** 已在列表里的模型 id */
  already: string[];
  onRetry: () => void;
  onClose: () => void;
  onConfirm: (ids: string[]) => void;
}

export function ModelPickDialog({
  source,
  phase,
  candidates,
  error,
  already,
  onRetry,
  onClose,
  onConfirm,
}: Props) {
  const alreadySet = useMemo(() => new Set(already), [already]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((id) => id.toLowerCase().includes(q));
  }, [candidates, query]);

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const canConfirm = phase === "error" ? manual.trim() !== "" : picked.size > 0;

  function confirm() {
    if (phase === "error") {
      onConfirm(
        manual
          .split(/[,，\s]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else {
      onConfirm([...picked]);
    }
  }

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide" role="dialog" aria-label="选择模型">
        <div className="dlghead">
          <h3>选择模型</h3>
        </div>

        {phase === "loading" ? (
          <div className="d3body">
            <div className="skelrow" />
            <div className="skelrow" />
            <div className="skelrow" />
            <div className="d3state">
              <b>正在请求 /v1/models</b>
              <p>若上游不实现该接口，会退回到手动添加。</p>
            </div>
          </div>
        ) : phase === "error" ? (
          <div className="d3body">
            <div className="d3state">
              <b>模型列表没拉到</b>
              {error && (
                <p style={{ marginTop: 6 }}>
                  <span className="mono">{error}</span>
                </p>
              )}
              <p style={{ marginTop: 8 }}>
                不少自建网关不实现 <span className="mono">GET /v1/models</span>。
                可以直接在下面填模型 ID，多个用逗号分隔。
              </p>
            </div>
            <div className="field">
              <label>模型 ID</label>
              <input
                className="inp"
                placeholder="deepseek-v4-flash, kimi-k2.7-code"
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && canConfirm && confirm()}
                autoFocus
              />
            </div>
          </div>
        ) : (
          <>
            <div className="dlgsearch" style={{ marginBottom: 8 }}>
              <SearchIcon />
              <input
                placeholder="搜索模型 ID"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button
                className="btn2"
                style={{ padding: "3px 8px", fontSize: 11 }}
                onClick={() => setPicked(new Set(candidates))}
              >
                全选
              </button>
              <button
                className="btn2"
                style={{ padding: "3px 8px", fontSize: 11 }}
                onClick={() => setPicked(new Set())}
              >
                清空
              </button>
            </div>
            <div className="d3body">
              {shown.length === 0 ? (
                <div className="empty">没有匹配「{query}」的模型</div>
              ) : (
                <>
                  <div className="mgroup">
                    可用模型<span style={{ color: "var(--ink3)" }}>{shown.length}</span>
                  </div>
                  {shown.map((id) => {
                    const on = picked.has(id);
                    const has = alreadySet.has(id);
                    return (
                      <button
                        className={`m3row ${on ? "on" : ""}`}
                        key={id}
                        onClick={() => (has ? undefined : toggle(id))}
                        disabled={has}
                        title={has ? "已在模型列表里" : undefined}
                        style={has ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
                      >
                        <span className="cb">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m5 12 5 5L20 6" />
                          </svg>
                        </span>
                        <span className="m3name">
                          <span className="nm">{id}</span>
                        </span>
                        {has && <span className="m3ctx">已在列表中</span>}
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          </>
        )}

        <div className="d3foot">
          <span className="d3count">
            {phase === "list" ? `已选 ${picked.size} 个模型` : ""}
          </span>
          {phase === "error" && (
            <button className="btn2" onClick={onRetry}>
              重新获取
            </button>
          )}
          <button className="btn2" onClick={onClose}>
            取消
          </button>
          <button className="btn2 primary" disabled={!canConfirm} onClick={confirm}>
            加入列表
          </button>
        </div>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      style={{ color: "var(--ink3)", flex: "none" }}
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
