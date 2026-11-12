/**
 * 设置 · 模型供应商。
 *
 * 三栏布局，规格取自 OpenDesign 稿件 settings-providers.html。
 *
 * 设计稿要求「不做假入口」，所以：
 *   - 侧栏只放已实现的（模型供应商）；通用/关于 也没有内容，同样标「即将推出」
 *   - 余额、购买套餐、远程调用、付费锁 —— 依赖账号与计费体系，
 *     本地版没有这些概念，整块不渲染
 *   - 模型开关 = 该模型是否出现在 models.json（不启用就不进对话页的模型选择）
 */
import { useMemo, useState } from "react";
import type { ModelDescriptor, ProviderView } from "@rakko/shared";
import { useProviders } from "./use-providers.js";
import type { ProviderPreset } from "./provider-presets.js";
import { AddProviderDialog } from "./AddProviderDialog.js";
import { CustomProviderDialog } from "./CustomProviderDialog.js";
import "./settings.css";

interface Props {
  onBack: () => void;
}

/** 侧栏条目。onlyImpl = 已实现，可点；其余置灰。 */
const NAV_ITEMS: Array<{ label: string; impl?: boolean }> = [
  { label: "通用" },
  { label: "外观" },
  { label: "个性化" },
  { label: "模型供应商", impl: true },
  { label: "用量和计费" },
  { label: "语音输入" },
  { label: "-" },
  { label: "IM 机器人" },
  { label: "键盘快捷键" },
  { label: "存储空间" },
  { label: "-" },
  { label: "关于" },
];

export function SettingsPage({ onBack }: Props) {
  const { providers, loading, error, reload, create, update, remove, listRemote, test } =
    useProviders();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [navQuery, setNavQuery] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [preset, setPreset] = useState<ProviderPreset | null>(null);

  // 选中项：显式选择优先，否则取第一个
  const selected = useMemo(
    () => providers.find((p) => p.id === selectedId) ?? providers[0] ?? null,
    [providers, selectedId],
  );

  const visibleNav = useMemo(() => {
    const q = navQuery.trim().toLowerCase();
    if (!q) return NAV_ITEMS;
    return NAV_ITEMS.filter((i) => i.label !== "-" && i.label.toLowerCase().includes(q));
  }, [navQuery]);

  const visibleProviders = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter(
      (p) => p.name.toLowerCase().includes(q) || p.baseUrl.toLowerCase().includes(q),
    );
  }, [providers, filter]);

  return (
    <div className="setpage">
      <div className="setwrap">
        {/* ── 左：导航 ── */}
        <aside className="navcol">
          <div className="navhead">
            <button className="back" title="返回" onClick={onBack}>
              ←
            </button>
            <b>设置</b>
          </div>
          <div className="navsearch">
            <SearchIcon />
            <input
              placeholder="搜索设置"
              value={navQuery}
              onChange={(e) => setNavQuery(e.target.value)}
            />
          </div>
          <div className="navlist">
            {visibleNav.map((item, i) =>
              item.label === "-" ? (
                <div className="navsep" key={`sep-${i}`} />
              ) : item.impl ? (
                <button className="navitem on" key={item.label}>
                  <ProviderIcon />
                  {item.label}
                </button>
              ) : (
                // 置灰但不响应：设计稿要求「不做假入口」
                <div className="navitem disabled" key={item.label} title="即将推出" aria-disabled>
                  {item.label}
                  <span className="soon">即将推出</span>
                </div>
              ),
            )}
          </div>
        </aside>

        {/* ── 中：供应商列表 ── */}
        <section className="provcol">
          <div className="provhead">
            <h2>模型供应商</h2>
            <p>选择模型的来源。每个来源提供它支持的模型与计费方式。</p>
          </div>
          <div className="provlist">
            {loading ? (
              <div className="empty">加载中…</div>
            ) : error ? (
              <div className="empty">
                读取失败
                <br />
                <span className="mono">{error}</span>
              </div>
            ) : visibleProviders.length === 0 ? (
              <div className="empty">
                {providers.length === 0 ? (
                  <>
                    还没有配置供应商
                    <br />
                    从下方「添加供应商」开始
                  </>
                ) : (
                  "没有匹配的供应商"
                )}
              </div>
            ) : (
              visibleProviders.map((p) => (
                <button
                  key={p.id}
                  className={`prov ${selected?.id === p.id ? "on" : ""}`}
                  onClick={() => setSelectedId(p.id)}
                >
                  <span className={`plogo ${p.hasKey ? "" : "light"}`}>
                    {initial(p.name)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="pname">{p.name}</div>
                    <div className="pmeta">
                      {p.models.length} 个模型
                      {!p.hasKey && " · 未设密钥"}
                    </div>
                  </div>
                  <span className={`pdot ${p.hasKey ? "" : "off"}`} />
                </button>
              ))
            )}
          </div>
          <div className="provfoot">
            <button className="footbtn" onClick={() => setAddOpen(true)}>
              ＋ 添加供应商
            </button>
            <button className="footbtn primary" onClick={() => setCustomOpen(true)}>
              自定义
            </button>
          </div>
        </section>

        {/* ── 右：详情 ── */}
        <section className="detailcol">
          {selected ? (
            <ProviderDetail
              provider={selected}
              modelQuery={modelQuery}
              onModelQuery={setModelQuery}
              onToggleModel={async (modelId, on) => {
                const next = on
                  ? selected.models
                  : selected.models.filter((m) => m.id !== modelId);
                await update(selected.id, { models: next });
              }}
              onRefresh={reload}
              onDelete={async () => {
                await remove(selected.id);
                setSelectedId(null);
              }}
              onTest={test}
            />
          ) : (
            <div className="empty" style={{ paddingTop: 60 }}>
              左侧还没有供应商
              <br />
              点「＋ 添加供应商」开始配置
            </div>
          )}
        </section>
      </div>

      {addOpen && (
        <AddProviderDialog
          onClose={() => setAddOpen(false)}
          onPickCustom={() => {
            setAddOpen(false);
            setCustomOpen(true);
          }}
          onPickPreset={(preset) => {
            setAddOpen(false);
            // 预设只是把表单预填好，仍然走自定义弹窗让用户填 key
            setCustomOpen(true);
            setPreset(preset);
          }}
        />
      )}

      {customOpen && (
        <CustomProviderDialog
          preset={preset}
          onClose={() => {
            setCustomOpen(false);
            setPreset(null);
          }}
          onCreate={async (input) => {
            await create(input);
            setCustomOpen(false);
            setPreset(null);
          }}
          listRemote={listRemote}
          test={test}
        />
      )}
    </div>
  );
}

/* ── 详情面板 ── */

interface DetailProps {
  provider: ProviderView;
  modelQuery: string;
  onModelQuery: (q: string) => void;
  onToggleModel: (modelId: string, on: boolean) => Promise<void>;
  onRefresh: () => Promise<void>;
  onDelete: () => Promise<void>;
  onTest: (baseUrl: string, apiKey: string, model: string) => Promise<unknown>;
}

function ProviderDetail({
  provider,
  modelQuery,
  onModelQuery,
  onToggleModel,
  onRefresh,
  onDelete,
}: DetailProps) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const shown = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) return provider.models;
    return provider.models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    );
  }, [provider.models, modelQuery]);

  // 按 id 前缀分组当「厂商」：设计稿里是厂商分组，我们只有模型 id，用前缀近似
  const groups = useMemo(() => {
    const map = new Map<string, ModelDescriptor[]>();
    for (const m of shown) {
      const key = vendorOf(m.id);
      const arr = map.get(key) ?? [];
      arr.push(m);
      map.set(key, arr);
    }
    return [...map.entries()];
  }, [shown]);

  return (
    <>
      <div className="dhead">
        <span className={`plogo ${provider.hasKey ? "" : "light"}`}>
          {initial(provider.name)}
        </span>
        <div className="dt">
          <h3>{provider.name}</h3>
          <div className="sub">{provider.baseUrl}</div>
          <div className="sub" style={{ fontFamily: "ui-monospace, monospace", fontSize: 10.5 }}>
            {provider.api} · {provider.hasKey ? provider.keyMask : "未设置密钥"}
          </div>
        </div>
        <span className={`connected ${provider.hasKey ? "" : "warn"}`}>
          {provider.hasKey ? "已连接" : "未配置"}
        </span>
      </div>

      <div className="mhead">
        <b>模型</b>
        <span className="cnt">已选 {provider.models.length} 个</span>
        <span className="sp" />
        <button
          className="iconbtn"
          title="刷新模型列表"
          onClick={async () => {
            setBusy(true);
            await onRefresh();
            setBusy(false);
          }}
          disabled={busy}
        >
          ⟳
        </button>
        <button
          className="iconbtn"
          title={confirmDelete ? "再点一次确认删除" : "删除供应商"}
          onClick={async () => {
            if (!confirmDelete) {
              setConfirmDelete(true);
              setTimeout(() => setConfirmDelete(false), 3000);
              return;
            }
            await onDelete();
          }}
          style={confirmDelete ? { color: "var(--warn)", borderColor: "var(--warn)" } : undefined}
        >
          ✕
        </button>
      </div>

      <div className="filters">
        <div className="msearch">
          <SearchIcon />
          <input
            placeholder="搜索模型"
            value={modelQuery}
            onChange={(e) => onModelQuery(e.target.value)}
          />
        </div>
      </div>

      {provider.models.length === 0 ? (
        <div className="empty" style={{ paddingTop: 30 }}>
          这个供应商还没有模型
          <br />
          删除后重新添加，或到「添加供应商」里拉取模型列表
        </div>
      ) : shown.length === 0 ? (
        <div className="empty" style={{ paddingTop: 30 }}>
          没有匹配「{modelQuery}」的模型
        </div>
      ) : (
        groups.map(([vendor, models]) => (
          <div key={vendor}>
            <div className="vendor">
              {vendor}
              <span className="vcount">{models.length}</span>
            </div>
            {models.map((m) => (
              <ModelRow
                key={m.id}
                model={m}
                on={true}
                onToggle={() => onToggleModel(m.id, false)}
              />
            ))}
          </div>
        ))
      )}
    </>
  );
}

function ModelRow({
  model,
  on,
  onToggle,
}: {
  model: ModelDescriptor;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`mrow ${on ? "" : "off"}`}>
      <span className="mico">{initial(model.name)}</span>
      <div className="mname">
        <span className="nm" title={model.id}>
          {model.name || model.id}
        </span>
      </div>
      <span className="mctx">{ctxLabel(model.contextWindow)}</span>
      <span className="sp" />
      <button
        className={`toggle ${on ? "on" : ""}`}
        onClick={onToggle}
        title={on ? "从模型中移除" : "加入模型列表"}
        aria-pressed={on}
      />
    </div>
  );
}

/* ── 小工具 ── */

function initial(s: string): string {
  return (s.trim()[0] ?? "?").toUpperCase();
}

/**
 * 从模型 id 猜厂商前缀，做分组标题。
 * 拿不到就归到「其他」——宁可粗一点，也不要编造厂商名。
 */
function vendorOf(id: string): string {
  const l = id.toLowerCase();
  if (l.startsWith("deepseek")) return "DeepSeek";
  if (l.startsWith("kimi") || l.startsWith("moonshot")) return "月之暗面";
  if (l.startsWith("qwen") || l.startsWith("qwen")) return "通义千问";
  if (l.startsWith("gpt") || l.startsWith("o1") || l.startsWith("o3")) return "OpenAI";
  if (l.startsWith("claude")) return "Anthropic";
  if (l.startsWith("glm")) return "智谱";
  if (l.startsWith("hunyuan")) return "腾讯";
  if (l.startsWith("doubao")) return "字节跳动";
  if (l.startsWith("minimax")) return "MiniMax";
  return "其他";
}

function ctxLabel(n: number): string {
  if (!n || n <= 0) return "";
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
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

function ProviderIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="3" />
      <circle cx="5" cy="6" r="2" />
      <circle cx="19" cy="6" r="2" />
      <circle cx="5" cy="18" r="2" />
      <circle cx="19" cy="18" r="2" />
    </svg>
  );
}
