# 权限审批：Cindy 的实现与我们的方案

> 证据：实读 `packages/maker-core/src/agents/pi/cindy-bridge-source.ts`（238KB）。
> 结论先给：**pi 原生没有工具审批，必须注入一个扩展去拦截 `tool_call`**。Cindy 就是这么做的，我们也照做。

---

## 一、pi 原生有什么、没有什么

| | 状态 |
|---|---|
| 工具沙箱 | ❌ 没有。`security.md` 明确写：不沙箱、不限制工具 |
| 工具审批 | ❌ 没有 |
| 扩展机制 | ✅ **有**。`pi.on('tool_call')` 可以拦截并返回 `{ block: true }` |
| 扩展如何加载 | `agentHome/extensions/*.ts`，或 `--extension <path>` |

**关键**：`tool_call` hook 能 `return undefined` 放行，或 `return { block: true, reason }` 拦截。
这就是权限门的落点。

---

## 二、Cindy 怎么做（读源码得出）

### 2.1 把扩展源码写进 agentHome

```ts
// cindy-bridge-source.ts 是一个「字符串常量」，内容是一段完整的 pi 扩展
export const CINDY_BRIDGE_EXTENSION_FILENAME = "cindy-bridge.ts";

// 每次 startSession 把它覆写到 <agentHome>/extensions/cindy-bridge.ts
```

为什么用字符串而不是普通 ts 文件？

> 这段代码跑在 **pi 子进程**里，不能 import cindy 任何模块；只依赖 pi 的 ExtensionAPI、fetch 与 node:fs。

因为 pi 子进程有自己的模块解析规则，宿主代码不能直接被它 import。所以把「运行时需要的所有东西」都塞进一个自包含的源文件里，写盘，让 pi 加载。

### 2.2 权限档从文件现读（热切换）

```ts
function currentPermissionState(): { mode: 'ask' | 'bypassPermissions', ... } {
  const file = process.env.CINDY_PI_PERMISSION_FILE ?? '';
  if (!file) return { mode: 'ask', ... };          // 读不到 → fail-closed
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      mode: parsed?.mode === 'bypassPermissions' ? 'bypassPermissions' : 'ask',
      ...
    };
  } catch { /* fail-closed */ }
}
```

**每次 `tool_call` 都重新读** —— 这是热切换能生效的原因。切换权限档不需要重启 pi 进程。

**注意 fail-closed**：文件不存在、解析失败、字段非法 → 一律当 `ask`（最严）。
这与我们的不变量 1、4 一致。

### 2.3 拦截逻辑（简化自真实代码）

```ts
pi.on('tool_call', async (event, ctx) => {
  const permission = currentPermissionState();

  // 1. 完全访问：直接放行（除了控制面写入）
  if (permission.mode === 'bypassPermissions' && !controlPlaneWrite) return;

  // 2. 只读内置工具：直接放行（除非读凭证）
  if (READONLY_BUILTINS.has(event.toolName) && !credentialRead) return;

  // 3. 其余全部走审批
  const decision = await ctx.ui.input(PERMISSION_TITLE, JSON.stringify({
    toolName: event.toolName,
    input: event.input,
  }));

  if (decision !== PERMISSION_ALLOW) {
    return { block: true, reason: permissionDenialReason(decision) };
  }
});
```

### 2.4 `ctx.ui.input` 是私有信封，不是文本框

注释写得很清楚：

> `input()` is used as a private request/response envelope rather than a visible text box. Unlike `confirm()`, it can return **why** Cindy denied the request, so an automatic review block is not misreported as a user click.

意思是：用 `ctx.ui.input` 的`title` + `body` 传结构化数据，宿主收到后**不显示输入框**，而是渲染成审批卡。响应值用 `PERMISSION_ALLOW` 这类固定字符串传回决定。

`confirm()` 只能返回 boolean，分不清「用户拒绝」还是「自动审核拒绝」。

### 2.5 控制面写入即使完全访问也要确认

```ts
// agentHome 里有 models.json / 权限档 / bridge 扩展。
// 模型改写 models.json 的 baseUrl 可把后续请求全部 MITM 到攻击者 endpoint。
const agentHomeDir = process.env.PI_CODING_AGENT_DIR;
const writeInsideAgentHome = agentHomeDir && isInsideRoot(targetPath, agentHomeDir);
```

**这条对我们尤其重要**：我们的 `models.json` 里写着 proxy 地址和占位 key。如果模型能改写它，就能把请求劫持到别处。

---

## 三、我们的方案

### 3.1 架构

```
<sessionDataDir>/agent-home/
├── models.json              ← 已有
├── append-system-prompt.md  ← 已有
├── extensions/
│   └── rakko-bridge.ts      ← 新增：权限门
├── runtime/
│   └── perm.json            ← 新增：权限档（每次 tool_call 现读）
└── sessions/
```

```
pi 子进程
  pi.on('tool_call')
    → 读 runtime/perm.json（热切换就靠这里）
    → 判断：放行 / 拦截 / 询问
    → 询问走 ctx.ui.input → RPC extension_ui_request
       ↓ JSONL
  主进程 PiHost
    → 转成 AgentEvent.permission_request
       ↓ IPC
  Renderer：审批卡
    → 用户点允许/拒绝
       ↓ IPC
  主进程 → 写 extension_ui_response
       ↓ JSONL
  pi 子进程：拿到决定，继续或 block
```

### 3.2 我们和 Cindy 的差异

| | Cindy | 我们 |
|---|---|---|
| 扩展源码 | 238KB 字符串常量，含 MCP 桥、视觉桥、子代理、会话树 | **只做权限门，约 300 行** |
| 权限档 | `ask` / `bypassPermissions`（两档，代码里只有这两个） | 我们定义了 **三档** `ask`/`auto`/`bypassPermissions` |
| auto 档 | 由 Host 的 auto-review 分类器决定 | P0 先按「只读放行、写与命令询问」简化 |
| 凭证路径保护 | 三处同口径，几百行正则 | P0 先不做，P1 补 |
| MCP 审批 | 有 | P1 做 MCP 时再补 |

**关于三档**：Cindy 的代码里 `mode` 只有 `'ask' | 'bypassPermissions'`。他们的 `auto` 是在 Host 侧的另一套机制（`auto-review.ts`，367KB）。

我们的三档要在 bridge 里实现，需要更简单的规则。P0 建议：

```
ask               → 只读放行，其余全部询问
auto              → 只读放行，写文件询问，bash 询问     ← 与 ask 暂时相同
bypassPermissions → 除了控制面写入，全部放行
```

**auto 和 ask 在 P0 一样**，这是诚实的：真正的自动分类需要写一个分类器，那是 P1 的事。UI 上要标清楚「自动审批（P0 暂等同询问）」，不要骗用户。

### 3.3 数据契约

```ts
// 引擎 → 宿主：请求审批
export interface PermissionRequest {
  callId: string;
  toolName: string;
  input: unknown;
  risk: "low" | "medium" | "high";
  summary: string;        // 展示用，主进程生成
  /** 是否属于控制面（改 models.json / 权限档），这类即使完全访问也要问 */
  controlPlane: boolean;
}

// 宿主 → 引擎：决定
export type PermissionDecision = "allow-once" | "allow-type" | "deny";
```

### 3.4 bridge 源码（约 300 行，自包含）

```ts
// rakko-bridge.ts —— 写进 <agentHome>/extensions/
// 跑在 pi 子进程里，只依赖 pi 的 ExtensionAPI、node:fs、node:path
import { readFileSync } from "node:fs";
import path from "node:path";

const PERM_FILE = process.env.RAKKO_PI_PERMISSION_FILE ?? "";
const AGENT_HOME = process.env.PI_CODING_AGENT_DIR ?? "";
const ALLOW = "rakko:allow-once";
const ALLOW_TYPE = "rakko:allow-type";
const DENY = "rakko:deny";

const READONLY = new Set(["read", "ls", "grep", "find", "glob"]);
const WRITE = new Set(["write", "edit", "apply_patch"]);
const SHELL = new Set(["bash", "shell", "powershell"]);

type Mode = "ask" | "auto" | "bypassPermissions";

function readMode(): Mode {
  // fail-closed：读不到一律 ask
  if (!PERM_FILE) return "ask";
  try {
    const parsed = JSON.parse(readFileSync(PERM_FILE, "utf8"));
    const m = parsed?.mode;
    if (m === "bypassPermissions") return "bypassPermissions";
    if (m === "auto") return "auto";
    return "ask";
  } catch {
    return "ask";
  }
}

function insideAgentHome(p: unknown): boolean {
  if (typeof p !== "string" || !AGENT_HOME) return false;
  try {
    const rel = path.relative(AGENT_HOME, path.resolve(p));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

export default function (pi: any) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    const mode = readMode();
    const name = String(event.toolName ?? "");
    const input = event.input ?? {};

    // 控制面写入：即使完全访问也要问
    const controlPlane = WRITE.has(name) && insideAgentHome(input?.path);
    if (mode === "bypassPermissions" && !controlPlane) return;

    // 只读放行
    if (READONLY.has(name) && !controlPlane) return;

    // auto：写与命令都问（P0 暂与 ask 相同）
    const decision = await ctx.ui.input("rakko:permission", JSON.stringify({
      toolName: name,
      input,
      controlPlane,
    }));

    if (decision === ALLOW) return;
    if (decision === ALLOW_TYPE) return;    // P0 简化：同 allow，P1 再做类型级记忆
    return { block: true, reason: "Rakko：用户拒绝了这次工具调用。" };
  });
}
```

### 3.5 主进程侧

```ts
// PiHost 里新增：处理 extension_ui_request
private handleExtensionUiRequest(msg: any): void {
  if (msg.method !== "input" || msg.title !== "rakko:permission") {
    // 不是我们的请求，按 pi 默认拒绝，避免卡住
    this.respondUi(msg.id, "");
    return;
  }
  const payload = JSON.parse(msg.body);
  const request: PermissionRequest = { ...payload, callId: msg.id, risk: ..., summary: ... };
  this.options.onPermissionRequest(request);   // → AgentEvent.permission_request
}
```

---

## 四、待确认的一件事

**三档先按 P0 简化（auto 等同 ask），还是 P0 就把 auto 做成真分类器？**

- **简化**：约 1.5 人日，`auto` 标签写「P0 暂等同询问」
- **做完整**：约 5 人日，需要写风险分类器（命令解析、路径判定、凭证识别）

我建议简化。理由：auto 档的价值在于「少打扰」，但在 P0 阶段用户本来就少、工具调用也少，先保证「该拦的能拦住」比「少问几次」重要。

---

## 五、实施步骤

| 步骤 | 内容 | 验证 |
|---|---|---|
| 1 | 写 `rakko-bridge.ts` 源码常量 + 落盘逻辑 | 文件被写入 agentHome/extensions |
| 2 | 写 `perm.json` 读写（主进程侧） | 切换档位后文件变化 |
| 3 | PiHost 处理 `extension_ui_request` | 单测：非权限请求被正确拒绝 |
| 4 | `AgentEvent.permission_request` → IPC → 渲染层 | 端到端：bash 触发事件 |
| 5 | 审批卡 UI（**无设计稿，需你先确认**） | 点允许/拒绝，行为正确 |
| 6 | 控制面写入保护 | 单测：改 models.json 必须问 |

第 5 步会遇到设计稿缺口。按之前的约定，到时候我停下来给你设计方案。
