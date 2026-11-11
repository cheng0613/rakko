/**
 * 内置面板注册。
 *
 * 注册只做一次；但渲染需要的参数（sessionId 等）每次渲染都会变，
 * 所以用一个可变的 current 引用，让注册的 render 每次读最新的。
 */
import { CHAT_PANE_KIND } from "./layout-tree.js";
import { getPanel, registerPanel } from "./panel-registry.js";
import { ChatPage } from "../chat/ChatPage.js";
import type { PermissionMode } from "@rakko/shared";

export interface PanelRuntimeState {
  sessionId: string | null;
  appInfo: { name: string; version: string } | null;
  mode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
  initialPrompt: string | null;
  onConsumeInitialPrompt: () => void;
}

/**
 * 当前渲染参数。App 每次渲染时更新它。
 * 注册只做一次，render 内部读这里的最新值。
 */
export const panelRuntime: { current: PanelRuntimeState } = {
  current: {
    sessionId: null,
    appInfo: null,
    mode: "ask",
    onModeChange: () => {},
    initialPrompt: null,
    onConsumeInitialPrompt: () => {},
  },
};

/** 注册内置面板。幂等：重复调用不会抛错。 */
export function registerBuiltinPanels(): void {
  if (getPanel(CHAT_PANE_KIND)) return;

  registerPanel({
    kind: CHAT_PANE_KIND,
    title: "对话",
    closable: false,
    collapsible: false,
    render: ({ paneId }) => {
      const s = panelRuntime.current;
      if (!s.sessionId) {
        return (
          <div
            style={{
              flex: 1,
              display: "grid",
              placeItems: "center",
              color: "var(--ink3)",
              fontSize: 13,
            }}
          >
            正在创建会话…
          </div>
        );
      }
      return (
        <ChatPage
          key={`${paneId}-${s.sessionId}`}
          sessionId={s.sessionId}
          appInfo={s.appInfo}
          initialMode={s.mode}
          onModeChange={s.onModeChange}
          initialPrompt={s.initialPrompt}
          onConsumeInitialPrompt={s.onConsumeInitialPrompt}
        />
      );
    },
  });
}
