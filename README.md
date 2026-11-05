# Rakko

个人 agent 的执行内核与界面。品牌动物是海獭（rakko）—— 砸壳、海带缠身、手拉手成筏，
正好对应它的三件事：会用工具、能扛长任务、多端接着干。

当前进度：**M0 地基 + ① 持久化**。九张表真的建在 Postgres 上，运行、消息、事件、用量全部落库，
进程重启后数据还在。

## 已成型的决定

| 项 | 结论 |
| --- | --- |
| 事实源 | **Postgres 独占**，没有第二条写路径，进程里没有内存镜像 |
| 配额 | **按运行次数**，从 `usage_ledger` 求和；用超了按设置降级到快模型继续跑 |
| 模型 | **单 provider 起步**，熔断 + 半开探针兜底 |
| 语音 | 放 M7，不进 M0 |
| 导航 | 固定 5 项：对话 · 任务与自动化 · 记忆 · 技能 · 设置 |
| 技术栈 | pnpm monorepo、TypeScript、Fastify、Electron 桌面、Expo 移动 |

## 目录

```
packages/tokens     设计令牌：品牌六色 + 语义色板 + 深浅两套，唯一颜色来源
packages/protocol   zod 契约：运行状态、SSE 事件、REST DTO
packages/genui      生成式 UI 白名单 12 组件 + 树校验 + 降级文本
packages/core       状态机 · 熔断 · 配额规则 · provider 抽象
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
pnpm dev                                         # 内存实现，http://127.0.0.1:8787
DATABASE_URL=postgres://rakko:rakko@127.0.0.1:5433/rakko pnpm dev   # Postgres 实现
docker compose up -d --build                     # db + api 全容器化，api 启动时自动迁移
```

## 存储

`RunStore` 是唯一接口，两套实现行为一致：

| 实现 | 何时用 | 特点 |
| --- | --- | --- |
| `MemoryStore` | 没配 `DATABASE_URL`、单元测试 | 进程重启即清空 |
| `PostgresStore` | 配了 `DATABASE_URL` | 事实源，重启后数据仍在 |

`/health` 会回报 `store: "memory" | "postgres"`，不用猜自己连的哪个。

九张表：`users` / `threads` / `messages` / `runs` / `run_events` / `automations` / `skills` / `memories` / `usage_ledger`。

几个刻意的做法：

- **seq 由数据库算**（`coalesce(max(seq),0)+1` + 唯一索引兜底），进程不维护计数器，多实例也不会重号；
- **事件先落库再推送**，SSE 断线重连才能只靠 `Last-Event-ID` 续上；
- **配额只认 `usage_ledger` 的求和**，用户改不动这个数；
- 迁移目录按模块相对路径定位，从哪个目录起服务都不会找错。

## 接口（M0）

```
GET  /health                     服务、provider、store 标识
GET  /v1/usage                   配额（次数制，来自 usage_ledger）
GET  /v1/threads                 会话列表
POST /v1/threads                 新建会话
GET  /v1/threads/:id/messages    会话消息
POST /v1/runs                    发起一次运行（202，配额不足时 429 或降级）
GET  /v1/runs/:id                运行状态
GET  /v1/runs/:id/events         SSE 事件流，带 id 可续传
```

## 硬约束（写进代码，不写在文档里就没人守）

- 单色语义、无渐变、无阴影；正文永远用深栗 `#4A2E22`，天空蓝只做行动与状态。
- 颜色只允许引用语义名，禁止在组件里写裸十六进制。
- 生成式 UI 只能吐白名单里的 12 个组件，未声明属性一律拒绝。
- 运行状态变更只能走 `assertTransition`，非法变更抛错而不是静默丢弃。
- 取消的运行不扣配额；只有真正跑完的运行进 `usage_ledger`。

## 下一步

1. 接真 provider，把熔断的失败分支连到配额降级（现在是假 provider）。
2. 桌面壳（Electron）与移动端（Expo）共用 `packages/protocol` 与 tokens。
3. 界面按 `design.html` 的 AURA 稿逐屏落地，先做对话页与设置页。
4. 自动化、技能、记忆三张表已有 schema，等对应功能进 M2 再接上。
