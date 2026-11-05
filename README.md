# Rakko

个人 agent 的执行内核与界面。品牌动物是海獭（rakko）—— 砸壳、海带缠身、手拉手成筏，
正好对应它的三件事：会用工具、能扛长任务、多端接着干。

当前进度：**M0 地基 + Postgres 持久化 + 真模型接入**。九张表真的建在 Postgres 上，
运行、消息、事件、用量全部落库；模型走 OpenAI 兼容网关，主模型不行时自动降级到快档。

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
packages/core       状态机 · 熔断 · 配额规则 · provider 抽象 · 网关
packages/db         九张表的 drizzle schema、迁移、迁移执行器
apps/server         Fastify：threads / runs / SSE / usage；内存与 Postgres 两套 Store
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
GET  /health                     服务、provider、模型、熔断、store 状态
GET  /v1/usage                   配额（次数制，来自 usage_ledger）
GET  /v1/threads                 会话列表
POST /v1/threads                 新建会话
GET  /v1/threads/:id/messages    会话消息
POST /v1/runs                    发起一次运行（202，返回 tier/degraded；配额不足时 429）
GET  /v1/runs/:id                运行状态
GET  /v1/runs/:id/events         SSE 事件流，带 id 可续传
```

事件类型：`run.started` / `run.state` / `run.reasoning` / `run.delta` / `run.tool_call` /
`run.tool_result` / `run.fallback` / `run.error` / `run.done`。

## 硬约束（写进代码，不写在文档里就没人守）

- 单色语义、无渐变、无阴影；正文永远用深栗 `#4A2E22`，天空蓝只做行动与状态。
- 颜色只允许引用语义名，禁止在组件里写裸十六进制。
- 生成式 UI 只能吐白名单里的 12 个组件，未声明属性一律拒绝。
- 运行状态变更只能走 `assertTransition`，非法变更抛错而不是静默丢弃。
- 取消的运行不扣配额；只有真正跑完的运行进 `usage_ledger`。
- **思考内容不许拼进回答**，它有自己的事件类型。
- **key 只从环境变量读**，代码与仓库里不出现任何凭据；`.env` 已在 `.gitignore` 里。

## 下一步

1. 工具调用闭环：`tool_call` 事件已有，缺真正的执行器与 `waiting_approval` 审批流。
2. 桌面壳（Electron）与移动端（Expo）共用 `packages/protocol` 与 tokens。
3. 界面按 `design.html` 的 AURA 稿逐屏落地，先做对话页与设置页。
4. 自动化、技能、记忆三张表已有 schema，等对应功能进 M2 再接上。
