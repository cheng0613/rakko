# Rakko

个人 agent 的执行内核与界面。品牌动物是海獭（rakko）—— 砸壳、海带缠身、手拉手成筏，
正好对应它的三件事：会用工具、能扛长任务、多端接着干。

当前进度：**M0 地基 + Postgres 持久化 + 真模型接入 + 工具调用闭环 + 对话界面**。九张表真的建在 Postgres 上，
运行、消息、事件、用量全部落库；模型走 OpenAI 兼容网关，主模型不行时自动降级到快档；
模型能调工具，高风险工具会真的挂起等人点「允许」。

## 已成型的决定

| 项 | 结论 |
| --- | --- |
| 事实源 | **Postgres 独占**，没有第二条写路径，进程里没有内存镜像 |
| 配额 | **按运行次数**，从 `usage_ledger` 求和；用超了直接从快模型起跑 |
| 模型 | **单 provider 起步**：标准档 + 快档，熔断与降级都在网关层 |
| 语音 | 放 M7，不进 M0 |
| 导航 | 固定 5 项：对话 · 任务与自动化 · 记忆 · 技能 · 设置 |
| 技术栈 | pnpm monorepo、TypeScript、Fastify、Electron 桌面、Expo 移动 |

## 目录

```
packages/tokens     设计令牌：品牌六色 + 语义色板 + 深浅两套，唯一颜色来源
packages/protocol   zod 契约：运行状态、九种 SSE 事件、REST DTO
packages/genui      生成式 UI 白名单 12 组件 + 树校验 + 降级文本
packages/core       状态机 · 熔断 · 配额规则 · provider 抽象 · 网关 · 工具执行器 · 审批闸门 · agent 循环
packages/db         九张表的 drizzle schema、迁移、迁移执行器
apps/server         Fastify：threads / runs / SSE / approvals / usage；内存与 Postgres 两套 Store
apps/web            对话界面：自包含单文件，服务端直接在 / 吐出，同源无跨域
```

## 命令

```bash
pnpm install
pnpm typecheck      # 每个包 tsc --noEmit
pnpm test           # node:test；配了 DATABASE_URL 才会跑 Postgres 集成测试
pnpm build          # tsc 出 dist
pnpm verify         # 三条连跑

# 数据库
docker compose up -d db                          # Postgres 17，映射 5433
pnpm --filter @rakko/db db:generate              # 改完 schema 后生成迁移
pnpm --filter @rakko/server migrate              # 应用迁移（服务启动时也会自动跑）

# 跑起来
cp .env.example .env                             # 填 RAKKO_API_KEY，不填就用假 provider
node --env-file=.env apps/server/dist/index.js    # Postgres + 真模型
pnpm dev                                         # 内存实现 + 假 provider，改代码热重载
docker compose up -d --build                     # db + api 全容器化，api 启动时自动迁移
```

## 模型网关

`ModelProvider` 只负责传输，`ProviderGateway` 负责策略，`apps/server` 只认网关。

```
运行 ──▶ ProviderGateway ──┬─▶ standard 档（deepseek-v4-pro）
                           └─▶ fast 档（deepseek/deepseek-flash）
```

三条规则：

1. **熔断按档位分开计数**：连续失败 3 次开门，冷却 30 秒后只放一个探针；
2. **还没吐出回答时自动降级**：标准档报错 / 首字超时 / 正在熔断 → 换快档，并推一条
   `run.fallback` 事件说明原因；
3. **已经吐出内容就不换模型**：否则回答会重复，直接失败收尾，状态记 `failed`。

配额与降级的关系：`decideQuota` 判定 `degrade` 时，运行**直接从快档起跑**，不先撞一次主模型。

这些模型是「先思考再回答」的，流里有两类文本，必须分开：

- `reasoning_content` → `run.reasoning` 事件，只用于展示「正在想」；
- `content` → `run.delta` 事件，这才是回答，最终拼进 assistant 消息。

实测：一次回答里 reasoning 事件可达几百条，用 token 换质量，所以首字超时给了 45 秒。

## 工具与审批

一个运行 = 若干轮「模型说 → 工具做 → 结果回给模型」。循环在 `packages/core/src/agent.ts`，
最多 6 轮，到上限就停并告知用户，不无限自转。

| 工具 | 风险 | 要审批 | 说明 |
| --- | --- | --- | --- |
| `read_file` | low | 否 | 读工作区里的文本文件，超过 120KB 截断 |
| `list_dir` | low | 否 | 列目录，最多 200 项 |
| `write_file` | high | **是** | 写文件，自动建目录 |
| `shell` | high | **是** | 跑命令，默认 20s 超时，输出截断 8KB |

三条纪律：

1. **路径锁在工作区**：任何 `../` 解析到工作区外的路径直接拒，连读都不给读；
2. **要不要审批由风险决定**，不交给模型判断；模型只能调注册过的工具，参数一律 zod 校验后才执行；
3. **自毁类命令连审批都不给**：`rm -rf /`、`mkfs`、`dd of=/dev/`、`shutdown` 一律硬拦。

审批流：

```
运行 ──▶ 模型要求 write_file
          └─▶ 状态变 waiting_approval，推 run.approval_requested
                ├─ 人点允许 ──▶ 执行 → run.tool_result → 模型继续
                ├─ 人点拒绝 ──▶ 不执行，告诉模型「用户没允许」→ 模型换个做法
                └─ 10 分钟无人理 ──▶ 自动拒绝，运行照样收尾，不会烂在那里
```

`waiting_approval` 只是等一次点击，不是失败；**被拒也不算失败**——模型会读到拒绝理由并换路子。
进程重启时，停在 `queued` / `running` / `waiting_approval` 的运行会被标成 `failed`（“服务重启，这次运行被中断了”），
因为已经没有进程在推它了，留着只会把界面骗成“还在跑”。

## 界面

界面是 **一个自包含 HTML**（`apps/web/index.html`，样式与脚本全内联，不引任何外部资源），
由服务端在 `GET /` 直接吐出，所以和 API 同源、没有跨域问题；不装东西，双击也能开。

**界面用的是设计稿的样式表本身，不是照着重写一遍。** `design.html` 里那段 `<style>`（Apple HIG 令牌、
`.side` / `.nav-item` / `.topbar` / `.msg` / `.tool` / `.composer` / `.ctx` 这些类和几何）被整段同步进来：

```bash
node scripts/sync-design.mjs <design.html 路径>   # 只替换 ==DESIGN-CSS-START/END== 之间的内容
```

所以在设计稿里改颜色、改圆角、改间距，跑一次同步，界面跟着变；界面里只额外加了事件流专用的几块
（思考折叠、审批卡、降级提示、工具状态标签），全部复用同一套 `--line` / `--surface` / `--radius` 令牌。

三种打开方式：

```bash
node --env-file=.env apps/server/dist/index.js   # 然后开 http://127.0.0.1:8787/
```

| 地址 | 行为 |
| --- | --- |
| `/` | 真实模式：读会话列表、用量，发消息走真 API + SSE |
| `/?auto=1` | 真实模式，进页面自动发一句（演示/截图用） |
| `/?demo=1&auto=1` | 演示模式：不连服务端，脚本回放一次完整事件流（不需要后端） |
| `/?demo=1&auto=1&decide=allow` | 演示模式，并自动替你点「允许」 |

演示模式是为了「手机或静态预览也能看」：连不上服务端时它会自动接管，并在顶部说清楚这是演示数据。

界面里画出来的东西，正好是这套事件流：

- **思考**：`run.reasoning` 折叠成一行「思考了 3 秒 · 58 字」，点开看过程，回答区不受污染；
- **流式回答**：`run.delta` 直接追加，收尾时才做一次轻量 markdown 渲染（标题、列表、行内代码、代码块）；
- **工具卡**：`run.tool_call` 出现卡片（参数 + 状态），`run.tool_result` 回填结果，失败原因直接写出来；
- **审批卡**：`run.approval_requested` 弹出「需要你点头」，显示风险级别、路径/命令摘要、倒计时，
  两个按钮分别是允许/拒绝；拒绝的文案明确写着「不会让任务失败」，`run.approval_decided` 到了就把按钮换成结论；
- **降级提示**：`run.fallback` 显示成一条「降级」说明，不假装什么都没发生；
- **右侧运行时栏**：模型、本次工具调用数、等待审批数、本周用量、工具清单、存储与工作区，
  全部来自 `/health` 与事件流，不是写死的装饰；
- **用量**：`/v1/usage` 落成侧栏底部那一条（次数制，回写 `usage_ledger`）。

**这一轮只做桌面**（1440 基准，设计稿也是按桌面画的）。不为手机做布局、不写移动端覆盖；
设计稿样式表里的断点（≤1180 收右栏、≤980 抽屉）随样式表免费带着，能兜住但不打磨。

## 存储

`RunStore` 是唯一接口，两套实现行为一致：

| 实现 | 何时用 | 特点 |
| --- | --- | --- |
| `MemoryStore` | 没配 `DATABASE_URL`、单元测试 | 进程重启即清空 |
| `PostgresStore` | 配了 `DATABASE_URL` | 事实源，重启后数据仍在 |

`/health` 会回报 `store`、`provider`、`models` 和两个档位的 `breakers` 状态，不用猜。

九张表：`users` / `threads` / `messages` / `runs` / `run_events` / `automations` / `skills` / `memories` / `usage_ledger`。

几个刻意的做法：

- **seq 由数据库算**（`coalesce(max(seq),0)+1` + 唯一索引兜底），进程不维护计数器；
- **事件先落库再推送**，SSE 断线重连才能只靠 `Last-Event-ID` 续上；
- **配额只认 `usage_ledger` 的求和**，用户改不动这个数；
- 迁移目录按模块相对路径定位，从哪个目录起服务都不会找错。

## 接口（M0）

```
GET  /health                                   服务、provider、模型、熔断、工具、等待中的审批
GET  /v1/usage                                 配额（次数制，来自 usage_ledger）
GET  /v1/threads                               会话列表
POST /v1/threads                               新建会话
GET  /v1/threads/:id/messages                  会话消息
POST /v1/runs                                  发起运行（202，返回 tier/degraded；配额不足时 429）
GET  /v1/runs/:id                              运行状态 + pendingApprovals
GET  /v1/runs/:id/events                       SSE 事件流，带 id 可续传
POST /v1/runs/:id/approvals/:callId            审批：{"decision":"allow"|"deny","reason":"…"}
POST /v1/runs/:id/cancel                       取消运行（会把等待中的审批一并作废）
```

事件类型：`run.started` / `run.state` / `run.reasoning` / `run.delta` / `run.tool_call` /
`run.tool_result` / `run.approval_requested` / `run.approval_decided` / `run.fallback` /
`run.error` / `run.done`。

## 硬约束（写进代码，不写在文档里就没人守）

- 单色语义、无渐变、无阴影；正文永远用深栗 `#4A2E22`，天空蓝只做行动与状态。
- 颜色只允许引用语义名，禁止在组件里写裸十六进制。
- 生成式 UI 只能吐白名单里的 12 个组件，未声明属性一律拒绝。
- 运行状态变更只能走 `assertTransition`，非法变更抛错而不是静默丢弃。
- 取消的运行不扣配额；只有真正跑完的运行进 `usage_ledger`。
- **思考内容不许拼进回答**，它有自己的事件类型。
- **key 只从环境变量读**，代码与仓库里不出现任何凭据；`.env` 已在 `.gitignore` 里。
- **文件工具的路径必须落在工作区内**，越界一律拒；自毁命令连审批都不给。
- **审批只能 allow / deny**，不允许在审批时改参数 —— 那等于让人替模型写代码。

## 下一步

1. 界面补齐：会话重命名/删除、工具卡里直接看 diff、审批卡支持“允许这一次 / 允许这类工具”。
2. 工具补齐：`grep`、`apply_patch`、HTTP 请求，以及“同一工具连续失败就换策略”的退让逻辑。
3. 审批持久化：现在等待中的审批只在内存里，重启即作废。要支持隔天回来再批，得落库。
4. 桌面壳（Electron）接上同一套 `packages/protocol` 与 tokens；移动端（Expo）暂缓。
5. 设置页按 `design.html` 的 AURA 稿落地（计划与用量、模型、连接器）。
6. 自动化、技能、记忆三张表已有 schema，等对应功能进 M2 再接上。
