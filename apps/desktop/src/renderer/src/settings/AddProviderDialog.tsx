/**
 * 「添加供应商」弹窗。
 *
 * 设计稿里分「推荐 / 订阅账号 / 更多供应商」三组，其中
 * 「检测到本机已安装 Claude Code CLI」「订阅账号」这类能力我们没有
 * （不做 CLI 探测、不做 OAuth 登录），按「不做假入口」原则去掉。
 *
 * 剩下的每一项都通向能真正工作的路径：选一项 → 打开自定义弹窗并预填地址。
 */
import { useMemo, useState } from "react";
import { PROVIDER_PRESETS, type ProviderPreset } from "./provider-presets.js";

interface Props {
  onClose: () => void;
  onPickCustom: () => void;
  onPickPreset: (preset: ProviderPreset) => void;
}

export function AddProviderDialog({ onClose, onPickCustom, onPickPreset }: Props) {
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PROVIDER_PRESETS;
    return PROVIDER_PRESETS.map((g) => ({
      ...g,
      items: g.items.filter(
        (i) => i.name.toLowerCase().includes(q) || i.baseUrl.toLowerCase().includes(q),
      ),
    })).filter((g) => g.items.length > 0);
  }, [query]);

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="添加供应商">
        <div className="dlghead">
          <h3>添加供应商</h3>
          <button className="custom" onClick={onPickCustom}>
            没找到？添加自定义
          </button>
        </div>
        <div className="dlgsearch">
          <SearchIcon />
          <input
            placeholder="搜索供应商..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        <div className="dlgbody">
          {groups.length === 0 ? (
            <div className="empty">
              没有匹配「{query}」的预设
              <br />
              点右上角「添加自定义」直接填地址
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.label}>
                <div className="dgroup">{g.label}</div>
                {g.items.map((p) => (
                  <button className="drow" key={p.name} onClick={() => onPickPreset(p)}>
                    <span className="dico">{p.name[0]}</span>
                    <span className="dlabel">{p.name}</span>
                    <span className="dhint">{hostOf(p.baseUrl)}</span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="dlgfoot">
          <button className="btn2" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function SearchIcon() {
  return (
    <svg
      width="13"
      height="13"
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
