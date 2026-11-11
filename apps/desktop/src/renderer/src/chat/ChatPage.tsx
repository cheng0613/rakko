import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BYPASS_WARNING,
  PERMISSION_MODES,
  PERMISSION_MODE_LABEL,
  PRODUCT_NAME,
  coercePermissionMode,
} from "@rakko/shared";
import type { AgentEvent, ModelSummary, PermissionMode } from "@rakko/shared";
import type { RakkoApi } from "@rakko/shared";
import {
  appendUserMessage,
  initialChatState,
  reduceEvent,
  summarizeToolInput,
  type Block,
  type ChatState,
} from "./state.js";
import "./chat.css";

declare global {
  interface Window {
    rakko: RakkoApi;
  }
}

const SESSION_ID = "local-1";

export function ChatPage({ appInfo }: { appInfo: { name: string; version: string } | null }) {
  const [chat, setChat] = useState<ChatState>(initialChatState);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<PermissionMode>("ask");
  const [status, setStatus] = useState<string>("未连接");
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const streamRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);

  const effectiveMode = coercePermissionMode(mode);

  // 订阅事件
  useEffect(() => {
    const unsubscribe = window.rakko.onAgentEvent(SESSION_ID, (event: AgentEvent) => {
      setChat((prev) => reduceEvent(prev, event));
    });
    return unsubscribe;
  }, []);

  // 自动滚到底部
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chat.messages]);

  const ensureSession = useCallback(async (): Promise<void> => {
    if (startedRef.current) return;
    setStatus("启动 pi…");

    try {
      // 模型列表由主进程给出；真正启动时会再读一次 provider 与 key
      const list = await window.rakko.listModels();
      setModels(list);
      if (list.length === 0) {
        setStatus("未配置模型");
        setError(
          "还没有配置模型。P0 阶段请设置环境变量 RAKKO_BASE_URL / RAKKO_MODEL / RAKKO_API_KEY 后重启。" +
            "设置页与 CompatProxy 会在后续步骤接入。",
        );
        return;
      }

      await window.rakko.startSession({
        sessionId: SESSION_ID,
        cwd: ".",
        promptSections: ["你是 Rakko，一个桌面助手。回答简洁、准确。"],
        tools: "all",
      });
      startedRef.current = true;
      setStatus("就绪");
      setError(null);
    } catch (e) {
      setStatus("启动失败");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const handleSend = useCallback(async (): Promise<void> => {
    const text = input.trim();
    if (!text) return;

    setChat((prev) => appendUserMessage(prev, text));
    setInput("");

    try {
      await ensureSession();
      if (!startedRef.current) return;
      await window.rakko.sendMessage({ sessionId: SESSION_ID, text });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [input, ensureSession]);

  const handleStop = useCallback(async (): Promise<void> => {
    try {
      await window.rakko.abort(SESSION_ID);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const usageText = useMemo(() => {
    const u = chat.totalUsage;
    if (u.inputTokens + u.outputTokens === 0) return null;
    return `↑${u.inputTokens} ↓${u.outputTokens}`;
  }, [chat.totalUsage]);

  return (
    <div className="chat-page">
      <header className="titlebar">
        <span className="logo" aria-hidden>
          π
        </span>
        <span className="tname">{appInfo?.name ?? PRODUCT_NAME}</span>
        <span className="meta">{appInfo ? `v${appInfo.version}` : ""}</span>
        {chat.busy && <span className="sdot" title="进行中" />}
        <span className="spacer" />
        {usageText && <span className="meta mono">{usageText}</span>}
        <span className="meta">{status}</span>
      </header>

      <div className="stream" ref={streamRef}>
        {chat.messages.length === 0 && !error && (
          <div className="empty">
            <div>
              <p>和 Rakko 说点什么。</p>
              <p style={{ marginTop: 6, fontSize: 12 }}>
                P0 阶段：需要先设置 RAKKO_MODEL 与 RAKKO_API_KEY 环境变量
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="empty">
            <div className="err" style={{ maxWidth: 520 }}>
              {error}
            </div>
          </div>
        )}

        {chat.messages.map((m) => (
          <MessageRow key={m.id} role={m.role} blocks={m.blocks} endReason={m.endReason} />
        ))}
      </div>

      <div className="composer">
        <div className="cbar">
          <button
            className={`ppill ${effectiveMode === "bypassPermissions" ? "warn" : ""}`}
            title={effectiveMode === "bypassPermissions" ? BYPASS_WARNING : PERMISSION_MODE_LABEL[effectiveMode]}
            onClick={() => {
              const idx = PERMISSION_MODES.indexOf(effectiveMode);
              setMode(PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length]!);
            }}
          >
            {PERMISSION_MODE_LABEL[effectiveMode]}
          </button>

          <textarea
            className="cinput"
            rows={1}
            placeholder="回复 Rakko，或输入新指令…（Enter 发送，Shift+Enter 换行）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />

          {chat.busy ? (
            <button className="csend stop" onClick={() => void handleStop()} title="停止">
              ■
            </button>
          ) : (
            <button
              className="csend"
              onClick={() => void handleSend()}
              disabled={input.trim().length === 0}
              title="发送"
            >
              ↑
            </button>
          )}
        </div>
      </div>

      <footer className="statusline">
        <span>session: {SESSION_ID}</span>
        <span>models: {models.length}</span>
        {chat.currentTurnId && <span>turn: {chat.currentTurnId}</span>}
        {chat.lastError && <span className="err">错误：{chat.lastError}</span>}
      </footer>
    </div>
  );
}

function MessageRow({
  role,
  blocks,
  endReason,
}: {
  role: "user" | "assistant";
  blocks: Block[];
  endReason?: "done" | "aborted" | "error";
}) {
  if (role === "user") {
    const text = blocks
      .filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text")
      .map((b) => b.text)
      .join("");
    return (
      <div className="msg user">
        <div className="bubble">{text}</div>
      </div>
    );
  }

  return (
    <div className="msg">
      <span className="mava" aria-hidden>
        π
      </span>
      <div className="mbody">
        {blocks.map((b, i) => {
          if (b.kind === "text") return <div key={i} className="bubble">{b.text}</div>;
          if (b.kind === "thinking") return <div key={i} className="thinking">{b.text}</div>;
          return <ToolCard key={b.callId} block={b} />;
        })}
        {endReason === "aborted" && <div className="thinking">已停止</div>}
        {endReason === "error" && <div className="thinking err">出错了</div>}
      </div>
    </div>
  );
}

function ToolCard({ block }: { block: Extract<Block, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeToolInput(block.input);
  const statusText =
    block.status === "running"
      ? "运行中…"
      : block.status === "error"
        ? "失败"
        : block.durationMs !== undefined
          ? `${block.durationMs}ms`
          : "完成";

  return (
    <div className="tool">
      <div className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className={`tool-chev ${open ? "open" : ""}`}>›</span>
        <span className="tool-name">{block.name}</span>
        {block.risk === "high" && <span className="tool-risk high">高风险</span>}
        <span className="meta" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {summary}
        </span>
        <span className="tool-status">{statusText}</span>
      </div>
      {open && block.result && <div className="tool-body">{block.result}</div>}
    </div>
  );
}

