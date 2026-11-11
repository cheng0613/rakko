# 接手须知

> 给在另一台电脑上继续这个项目的人（或另一个 agent）看的。
> 最后更新：2026-11-11，对应提交 `bed6111`。

---

## 一、三十秒了解现状

**Rakko** 是 pi 的桌面 GUI，纯本地，用户自带 key。目前 **P0 骨架完成**，
能真实使用：对话、工具调用、权限审批、会话持久化、上下文续接、空闲回收。

- 代码 **7,638 行**（49 个文件，不含测试）
- 测试 **261 项**，全过
- 提交 **20 个**，已推送到 `cheng0613/rakko` 的 `master`

**唯一还缺的 P0 功能是设置页 UI**（后端已完成，等设计稿）。

---

## 二、拉下来怎么跑

```bash
git clone https://github.com/cheng0613/rakko.git
cd rakko
pnpm install

# 关键一步：原生模块要针对 Electron ABI 编译
pnpm native:electron

pnpm verify     # typecheck + test + build，全绿才算环境正常
```

配模型（P0 阶段用环境变量）：

```bash
export RAKKO_BASE_URL="https://api.openai.com/v1"
export RAKKO_MODEL="gpt-5.4"
export RAKKO_API_KEY="sk-..."
pnpm dev
```

使用中的实测可用配置见 `docs/local-dev.md`。

---

## 三、三个必须知道的坑

### 1. 原生模块 ABI（最容易卡住）

`better-sqlite3` 是原生模块。**Node 和 Electron 的 ABI 不同，不能共用一个 .node**：

| 运行时 | ABI |
|---|---|
| 系统 Node 22 | 127 |
| Electron 33 | 130 |

A/B 两份编译产物存在 `build/Release/` 下，用脚本切换：

```bash
pnpm native:status     # 看当前用的哪份
pnpm native:node       # 跑测试前
pnpm native:electron   # 跑应用前
```

`pnpm test` / `build` / `dev` **已经自动切换**，一般不用手动。

**症状识别**：如果报 `NODE_MODULE_VERSION 127 ... requires 130`，
或数据库报「还没打开」，就是 ABI 不对。

**另一个陷阱**：`electron-rebuild` 在 Windows 上可能报 `✔ Rebuild Complete`
但产物 md5 与原件相同——**它根本没编译**。判断是否真重建要比 md5。

### 2. pi 的静默降级

`--append-system-prompt` 指向不存在的文件时，pi **不报错**，
而是把路径字符串当字面文本塞进 system prompt。

所以我们写了 `assertAppendPromptUsable` 在 spawn 前拦。改这块代码前先读
`packages/core/src/pi/__tests__/append-prompt.test.ts`。

### 3. Electron 里不能用 process.execPath 跑 pi

`process.execPath` 在 Electron 里是 `electron.exe`，不是 node。
用它跑 pi 的 cli.js 会崩且**没有错误输出**。

必须解析真 node 二进制（`resolveNodeBinary`）。这条踩了很久。

---

## 四、代码结构

```
packages/
  shared/   565 行  类型、IPC 契约、AgentEvent、权限档、模型预设
  core/    3,104 行 pi 集成、会话、权限门、运营商存储、SQLite（不 import electron）
  proxy/     347 行 CompatProxy：持有真 key，替换 Authorization，字节级 pipe
apps/
  desktop/ 3,205 行 Electron 主进程 + preload + renderer
docs/
  TODO.md                    待办清单（每条写清为什么待办）
  COMPARISON-WITH-CINDY.md   与 Cindy 的逐项对比与优缺点
  COMMITS.md                 提交规范
  local-dev.md               本地开发与实测可用的模型
  permission-design.md       权限门设计（含 Cindy 实现分析）
```

### 数据流

```
Renderer（React）
  ↓ IPC（preload 白名单桥）
Main
  ├─ SessionManager   会话生命周期 + 空闲回收
  ├─ PersistenceService  SQLite（项目/会话/消息）
  ├─ ProviderService  运营商配置（key 用 safeStorage 加密）
  └─ PiHost           spawn `pi --mode rpc`，JSONL 收发
       ↓
  pi 子进程（env 里只有占位 key）
       ↓ models.json 指向
  CompatProxy（127.0.0.1:随机端口，持有真 key）
       ↓ 替换 Authorization 后转发
  用户的上游
```

---

## 五、13 条不变量（`AGENTS.md` 有全文）

最容易违反的四条：

1. **权限档顺序** `[ask, auto, bypassPermissions]`，`[0]` 最严
2. **spawn env 同 sessionId 重建时逐字节稳定**（禁 randomBytes/时间戳）
3. **append 文件写后必须回读校验**（pi 会静默降级）
4. **用户 key 不进 spawn env**，只在 proxy 内存

---

## 六、当前状态一览

### 已完成

| 功能 | 状态 |
|---|---|
| pi 集成（spawn/translator/事件流） | ✅ 真模型验证 |
| CompatProxy（key 隔离） | ✅ 实测上游收到真 key、env 里只有占位 |
| 权限审批（拦截/审批卡/热切换） | ✅ 含控制面写入保护 |
| 首页启动台 | ✅ 接真实数据 |
| 对话页 | ✅ 流式 + 工具卡 + Markdown |
| 会话与消息持久化 | ✅ 重启不丢 |
| **会话上下文续接** | ✅ 跨重启后 pi 记得历史 |
| **空闲回收** | ✅ 30min TTL，零进程泄漏 |
| 布局树 + 持久化 | ✅ 未注册面板保留位置 |
| 运营商配置后端 | ✅ 增删改查/拉模型/测连通 |

### 待办（按优先级）

| 项 | 为什么 | 成本 |
|---|---|---|
| **设置页 UI** | 现在只能靠环境变量配模型 | 2–3 人日（**等设计稿**） |
| **auto 真分类器** | 现在名不副实（已标注「待实现」）| 3–5 人日 |
| 分割条拖拽 | 布局树有 fraction 但不能拖 | 1 人日 |
| 凭证路径保护 | 防 agent 读 `~/.ssh/id_rsa` | 1 人日 |
| compat 自愈 | 上游拒收缓存字段时自动降级 | 2 人日 |
| 分发方案 | 出 beta 前必须定（内置 vs CDN）| 3 人日 / 3-4 人周 |

详情见 `docs/TODO.md`。

---

## 七、做下一个功能前

1. 读 `docs/COMPARISON-WITH-CINDY.md` 的「三处我们做错了」——避免重复
2. 跑 `pnpm verify` 确认环境正常
3. 改 pi 相关代码前，先读对应的 `__tests__` 目录——那里记着踩过的坑

### 提交前

```bash
pnpm verify    # 全绿才能提交
```

提交格式见 `docs/COMMITS.md`。scope 用功能域
（`chat`/`home`/`session`/`model`/`proxy`/`permission`/`layout`），不用目录名。

---

## 八、还没做的验证

P0 的验证都是**脚本化 + agent dogfood**，没做过的：

- 连续使用数小时（会话切换、长对话、并发工具）
- 真实用户的操作习惯（哪些审批是多余的）
- 多项目切换
- 大仓库（几万文件）下的性能

这些只能在真实使用中暴露。
