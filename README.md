# Rakko

个人 agent 的执行内核与界面。品牌动物是海獭（rakko）—— 砸壳、海带缠身、手拉手成筏，
正好对应它的三件事：会用工具、能扛长任务、多端接着干。

这个仓库现在是 **M0 地基**：能装、能跑、能验、能起容器。界面与模型接入按 M1 往后排。

## 已成型的决定

| 项 | 结论 |
| --- | --- |
| 事实源 | **Postgres 独占**，不再有第二条写路径 |
| 配额 | **按运行次数**，用超了按设置降级到快模型继续跑，不中断任务 |
| 模型 | **单 provider 起步**，熔断 + 半开探针兜底 |
| 语音 | 放 M7，不进 M0 |
| 导航 | 固定 5 项：对话 · 任务与自动化 · 记忆 · 技能 · 设置 |
| 技术栈 | pnpm monorepo、TypeScript、Fastify、Electron 桌面、Expo 移动 |

## 目录

```
packages/tokens     设计令牌：品牌六色 + 语义色板 + 深浅两套，唯一颜色来源
packages/protocol   zod 契约：运行状态、SSE 事件、REST DTO
packages/genui      生成式 UI 白名单 12 组件 + 树校验 + 降级文本
packages/core       状态机 · 熔断 · 配额 · provider 抽象
packages/db         九张表的 drizzle schema + 连接
apps/server         Fastify 服务：threads / runs / SSE / usage
```

## 命令

```bash
pnpm install
pnpm typecheck      # 每个包 tsc --noEmit
pnpm test           # node:test 跑 dist 里的 *.test.js
pnpm build          # tsc 出 dist
pnpm verify         # 三条连跑

pnpm dev            # apps/server 热重载，默认 http://127.0.0.1:8787
docker compose up -d --build   # Postgres(5433) + api(8787)
```

M0 的验收就是这四条：`install` → `typecheck` → `test` → `build` 全绿。

## 接口（M0）

```
GET  /health                     服务与 provider 标识
GET  /v1/usage                   配额（次数制）
GET  /v1/threads                 会话列表
POST /v1/threads                 新建会话
GET  /v1/threads/:id/messages    会话消息
POST /v1/runs                    发起一次运行（202，配额不足时 429 或降级）
GET  /v1/runs/:id                运行状态
GET  /v1/runs/:id/events         SSE 事件流，带 id 可断线续传
```

## 硬约束（写进代码，不写在文档里就没人守）

- 单色语义、无渐变、无阴影；正文永远用深栗 `#4A2E22`，天空蓝只做行动与状态。
- 颜色只允许引用语义名，禁止在组件里写裸十六进制。
- 生成式 UI 只能吐白名单里的 12 个组件，未声明属性一律拒绝。
- 运行状态变更只能走 `assertTransition`，非法变更抛错而不是静默丢弃。
- 取消的运行不扣配额；只有真正跑完的运行进 `usage_ledger`。

## 下一步

1. M1：`packages/db` 接真连接 + 迁移，`Store` 从内存换 Postgres 实现。
2. M1：真 provider 接入，熔断接上 `decideQuota` 的降级分支。
3. M2：桌面壳（Electron）与移动端（Expo）共用 `packages/protocol` 与 tokens。
4. 界面按 `design.html` 的 AURA 稿逐屏落地，先做对话页与设置页。
