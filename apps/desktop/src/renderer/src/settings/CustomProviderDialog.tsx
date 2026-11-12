/**
 * 「添加自定义供应商」弹窗。
 *
 * 对照设计稿保留的部分：名称 / 基础 URL / API 密钥（可切换明文）/
 * 获取并选择模型 / 手动添加模型 / 高级连接设置 / 测试连接。
 *
 * 去掉的部分：「显示名称」旁无、以及协议形态里的 anthropic-messages。
 * 原因：内置 pi 裁掉了 Anthropic SDK，选了也跑不通。见 prepare-pi-runtime.mjs。
 */
import { useState } from "react";
import type {
  ListRemoteModelsResult,
  ModelDescriptor,
  PiApiForm,
  TestProviderResult,
  UpsertProviderInput,
} from "@rakko/shared";
import { ModelPickDialog } from "./ModelPickDialog.js";
import type { ProviderPreset } from "./provider-presets.js";

interface Props {
  preset: ProviderPreset | null;
  onClose: () => void;
  onCreate: (input: UpsertProviderInput) => Promise<void>;
  listRemote: (baseUrl: string, apiKey: string) => Promise<ListRemoteModelsResult>;
  test: (baseUrl: string, apiKey: string, model: string) => Promise<TestProviderResult>;
}

/** pi 支持、且我们内置运行时能跑起来的协议形态。 */
const API_FORMS: Array<{ value: PiApiForm; label: string }> = [
  { value: "openai-completions", label: "openai-completions（默认）" },
  { value: "openai-responses", label: "openai-responses" },
];

export function CustomProviderDialog({ preset, onClose, onCreate, listRemote, test }: Props) {
  const [name, setName] = useState(preset?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(preset?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [apiForm, setApiForm] = useState<PiApiForm>("openai-completions");
  const [headers, setHeaders] = useState("");

  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [manualIds, setManualIds] = useState("");
  const [pickOpen, setPickOpen] = useState(false);

  const [accModels, setAccModels] = useState(false);
  const [accAdvanced, setAccAdvanced] = useState(false);

  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [pickPhase, setPickPhase] = useState<"loading" | "list" | "error">("loading");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestProviderResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const canSave = name.trim() !== "" && baseUrl.trim() !== "" && models.length > 0 && !saving;

  async function handleFetch() {
    setFetching(true);
    setFetchError(null);
    setCandidates([]);
    setPickPhase("loading");
    setPickOpen(true);
    try {
      const res = await listRemote(baseUrl.trim(), apiKey);
      if (!res.ok) {
        setFetchError(`GET ${baseUrl.replace(/\/+$/, "")}/models 返回 ${res.status}`);
        setPickPhase("error");
        return;
      }
      if (res.models.length === 0) {
        setFetchError("上游返回了空列表");
        setPickPhase("error");
        return;
      }
      setCandidates(res.models.map((m) => m.id));
      setPickPhase("list");
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
      setPickPhase("error");
    } finally {
      setFetching(false);
    }
  }

  function applyManual() {
    const ids = manualIds
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const next = ids.map(descriptorOf);
    setModels((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      return [...prev, ...next.filter((m) => !seen.has(m.id))];
    });
    setManualIds("");
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      await onCreate({
        id: newProviderId(),
        name: name.trim(),
        api: apiForm,
        baseUrl: baseUrl.trim(),
        models,
        apiKey: apiKey || undefined,
      });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="dialog wide" role="dialog" aria-label="添加自定义供应商">
          <div className="dlghead">
            <h3>添加自定义供应商</h3>
          </div>
          <div className="d2body">
            <div className="field">
              <label htmlFor="cvName">显示名称</label>
              <input
                className="inp"
                id="cvName"
                placeholder="我的 AI 供应商"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="cvUrl">基础 URL</label>
              <input
                className="inp"
                id="cvUrl"
                placeholder="https://api.myprovider.com/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="cvKey">API 密钥</label>
              <div className="inpwrap">
                <input
                  className="inp"
                  id="cvKey"
                  type={showKey ? "text" : "password"}
                  placeholder="sk-..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                />
                <button
                  className="eye"
                  type="button"
                  title={showKey ? "隐藏" : "显示"}
                  onClick={() => setShowKey((v) => !v)}
                >
                  <EyeIcon off={showKey} />
                </button>
              </div>
              <div className="hint">密钥加密存在本地，不会进日志，也不会下发给渲染层的其他部分。</div>
            </div>

            <div className="mlistrow">
              <span className="mlt">
                {models.length === 0 ? "尚未获取模型列表" : `已选 ${models.length} 个模型`}
              </span>
              <button
                className="fetchbtn"
                onClick={handleFetch}
                disabled={fetching || !baseUrl.trim()}
                title={!baseUrl.trim() ? "先填基础 URL" : undefined}
              >
                {fetching ? "获取中…" : "获取并选择模型"}
              </button>
            </div>

            {models.length > 0 && (
              <div className="mchips">
                {models.map((m) => (
                  <span className="mchip" key={m.id}>
                    {m.id}
                    <button
                      title="移除"
                      onClick={() => setModels((prev) => prev.filter((x) => x.id !== m.id))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            <button
              className={`accrow ${accModels ? "open" : ""}`}
              onClick={() => setAccModels((v) => !v)}
            >
              <Chevron />
              手动添加模型
            </button>
            {accModels && (
              <div className="accbody">
                <div className="field">
                  <label>模型 ID</label>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      className="inp"
                      placeholder="例如 deepseek-v4-flash，多个用逗号分隔"
                      value={manualIds}
                      onChange={(e) => setManualIds(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && applyManual()}
                    />
                    <button className="btn2" onClick={applyManual} disabled={!manualIds.trim()}>
                      添加
                    </button>
                  </div>
                  <p>
                    用于上游不提供 <span className="mono">GET /v1/models</span> 的情况。
                    手动添加的模型会用默认上下文长度与计费占位值，
                    之后可以在 pi 配置里改。
                  </p>
                </div>
              </div>
            )}

            <button
              className={`accrow ${accAdvanced ? "open" : ""}`}
              onClick={() => setAccAdvanced((v) => !v)}
            >
              <Chevron />
              高级连接设置
            </button>
            {accAdvanced && (
              <div className="accbody">
                <div className="field">
                  <label htmlFor="cvApi">协议形态</label>
                  <select
                    className="inp"
                    id="cvApi"
                    value={apiForm}
                    onChange={(e) => setApiForm(e.target.value as PiApiForm)}
                  >
                    {API_FORMS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  <p>
                    只列出内置运行时支持的形态。
                    anthropic-messages 需要额外 SDK，当前版本未内置。
                  </p>
                </div>
                <div className="field">
                  <label htmlFor="cvHdr">自定义请求头（每行一个，格式 <span className="mono">Name: value</span>）</label>
                  <textarea
                    className="inp"
                    id="cvHdr"
                    rows={3}
                    placeholder={"X-Route: internal\nX-Tenant: demo"}
                    value={headers}
                    onChange={(e) => setHeaders(e.target.value)}
                    style={{ resize: "vertical", fontFamily: "ui-monospace, monospace", fontSize: 11.5 }}
                  />
                  <p>
                    写进 <span className="mono">models.json</span> 的 provider 块。
                    Rakko 自己会注入 <span className="mono">x-rakko-session-id</span>，不用手填。
                  </p>
                </div>
              </div>
            )}

            <div className="testrow">
              <button
                className="testbtn"
                onClick={async () => {
                  setTesting(true);
                  setTestResult(null);
                  try {
                    const first = models[0]?.id ?? "";
                    setTestResult(await test(baseUrl.trim(), apiKey, first));
                  } catch (e) {
                    setTestResult({
                      ok: false,
                      latencyMs: 0,
                      status: 0,
                      error: e instanceof Error ? e.message : String(e),
                    });
                  } finally {
                    setTesting(false);
                  }
                }}
                disabled={testing || !baseUrl.trim() || !apiKey}
                title={
                  !baseUrl.trim() ? "先填基础 URL" : !apiKey ? "先填 API 密钥" : undefined
                }
              >
                {testing ? "测试中…" : "测试连接"}
              </button>
              <div className="testhint">会发送一条简短生成请求，可能产生少量费用。</div>
            </div>

            {testResult && (
              <div className={`testresult ${testResult.ok ? "ok" : "err"}`}>
                {testResult.ok
                  ? `连接成功 · ${testResult.status} · ${testResult.latencyMs}ms${testResult.reply ? ` · 回复：${testResult.reply}` : ""}`
                  : `连接失败 · ${testResult.status || "无响应"}${testResult.error ? ` · ${testResult.error}` : ""}`}
              </div>
            )}

            {saveError && <div className="testresult err">{saveError}</div>}
          </div>

          <div className="dlgfoot">
            <button className="btn2" onClick={onClose}>
              取消
            </button>
            <button className="btn2 primary" onClick={handleSave} disabled={!canSave}>
              {saving ? "保存中…" : "保存供应商"}
            </button>
          </div>
        </div>
      </div>

      {pickOpen && (
        <ModelPickDialog
          source={baseUrl}
          phase={pickPhase}
          candidates={candidates}
          already={models.map((m) => m.id)}
          error={fetchError}
          onRetry={handleFetch}
          onClose={() => setPickOpen(false)}
          onConfirm={(ids) => {
            const existing = new Set(models.map((m) => m.id));
            const next = ids.filter((id) => !existing.has(id)).map(descriptorOf);
            setModels((prev) => [...prev, ...next]);
            setPickOpen(false);
          }}
        />
      )}
    </>
  );
}

/**
 * 从模型 id 造一个 pi 能接受的 descriptor。
 *
 * pi 对 models.json 很挑：cost 四项缺一个就整个文件作废，
 * 所有模型一起消失（见 AGENTS.md）。所以这里必须给全。
 */
/**
 * 生成 provider id。
 *
 * 后端要求 1–64 位「字母/数字/下划线/连字符」，且 id 与 title 无关，
 * 所以用随机串最省事。用 crypto.randomUUID 去掉连字符取前 16 位。
 */
function newProviderId(): string {
  const raw =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return raw.slice(0, 16);
}

function descriptorOf(id: string): ModelDescriptor {
  return {
    id,
    name: id,
    contextWindow: 128_000,
    maxOutput: 8_192,
    capabilities: { supportsTools: true, supportsImage: false, supportsThinking: false },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function Chevron() {
  return (
    <svg
      className="ic chev"
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.6" />
      {off && <path d="m4 20 16-16" />}
    </svg>
  );
}
