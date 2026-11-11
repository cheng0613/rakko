# Rakko

pi 的桌面 GUI。纯本地，用户自带 key，不做 SaaS。

---

## 现在是什么状态

**P0 骨架基本完成，已能真实使用。**

能做的事：

- 打开应用 → 首页启动台
- 输入任务 → agent 通过 pi 执行，实时流式回复
- agent 调用工具（bash / 读写文件等）→ **每次都会弹审批卡**
- 三种权限档可热切换（`每次询问` / `自动审批` / `完全访问`）
- 会话与消息落 SQLite，**重启后不丢**，首页能看到历史任务
- 你的 API key **不进 pi 子进程环境**，由本地代理持有

还没做（见 `docs/TODO.md`）：

- 设置页 UI（目前靠环境变量配模型）
- Markdown 渲染（agent 输出的格式现在显示成原文）
- auto 档的真实分类器（现在与「每次询问」相同）
- 会话续接的上下文恢复（打开旧会话能看到历史，但没接续到 pi）

---

## 快速开始

```bash
pnpm install
pnpm rebuild:native    # 首次必须：原生模块需要针对 Electron ABI 编译
pnpm verify            # typecheck + test + build
```

配置模型（P0 用环境变量，设置页做好后就不需要了）：

```bash
export RAKKO_BASE_URL="https://api.openai.com/v1"
export RAKKO_MODEL="gpt-5.4"
export RAKKO_API_KEY="sk-..."
pnpm dev
```

详见 `docs/local-dev.md`。

---

## 目录

```
packages/
  shared/    类型、IPC 契约、AgentEvent、权限档、模型预设、branding
  core/      pi 集成、会话运行时、权限门、运营商存储、SQLite（不 import electron）
  proxy/     CompatProxy：loopback 代理，持有真 key，字节级 pipe
apps/
  desktop/   Electron 主进程 + preload + renderer
```

---

## 关键约束

完整清单见 `AGENTS.md`（13 条不变量）。最容易踩的四条：

**1. 系统提示的追加文件必须回读校验。**
实测 pi 1.4.0：`--append-system-prompt` 指向不存在的文件时**静默把它当字面文本**，
不报错、退出码 0。用户看到的是「人格不对」，实际是路径错了。

**2. `models.json` 的 `cost` 必须四字段齐全。**
缺任何一个（`input`/`output`/`cacheRead`/`cacheWrite`）都会让整个文件校验失败、
**所有模型消失**。

**3. 用户 key 不进 spawn env。**
pi 的 `models.json` 里写 `$RAKKO_PI_API_KEY`，env 里只放占位值。
真 key 在 CompatProxy 内存里，请求时替换 Authorization 头。

**4. 原生模块的 ABI 问题。**
`better-sqlite3` 需要针对 Electron ABI 编译。`pnpm test` 用 Node ABI，
`pnpm dev`/`build` 用 Electron ABI，脚本会自动切换（`pnpm native:status` 看状态）。

前两条有测试守着，改动前先读 `packages/core/src/pi/__tests__/`。

---

## 提交

```bash
pnpm verify
git commit -m "feat(scope): 中文描述"
```

格式见 `docs/COMMITS.md`。scope 用功能域（`chat`/`home`/`session`/`model`/`proxy`/`permission`），
不用目录名。

---

## 与 Cindy 的关系

架构参考 `makecindy/cindy`（Apache-2.0）。借鉴的是**设计决策与踩坑结论**，代码是自己的：

- 三层解耦：共用主体不 import electron，平台能力走端口注入
- 统一 AgentEvent，UI 不直接消费 pi 事件
- 布局树：`chat-main` 恰好一个，面板身份用 `panelKind`
- 权限门：注入 pi 扩展拦截 `tool_call`（pi 原生没有审批机制）
- 权限档从严到宽，`[0]` 最严

不照搬：多 harness 抽象（只做 pi）、多端互联、IM、SaaS 商业层。

**比 Cindy 强的一点**：他们的 key 在 spawn env 里，文档必须承认「完全访问档下 token 可能被读走」。
我们的 key 不在，Agent 读环境变量只能拿到占位串。
