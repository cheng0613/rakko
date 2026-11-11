/**
 * 左侧 dock 导航。规格取自 OpenDesign 稿件。
 *
 * 只放**已经做出来的**入口。设计稿里有自动化/搜索/子代理/插件，
 * P0 还没实现 —— 不放假按钮，等做了再加。
 */
import "./dock.css";

export type DockRoute = "home" | "chat";

interface Props {
  route: DockRoute;
  onNavigate: (route: DockRoute) => void;
}

export function Dock({ route, onNavigate }: Props) {
  return (
    <nav className="dock">
      <div className="dockbar">
        <button
          className={`dbtn ${route === "home" ? "on" : ""}`}
          title="首页"
          onClick={() => onNavigate("home")}
        >
          <HomeIcon />
        </button>
        <button
          className={`dbtn ${route === "chat" ? "on" : ""}`}
          title="对话"
          onClick={() => onNavigate("chat")}
        >
          <ChatIcon />
        </button>
      </div>
    </nav>
  );
}

function HomeIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20h13V9.5" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z" />
    </svg>
  );
}
