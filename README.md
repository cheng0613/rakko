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
apps/desktop        桌面壳：一个窗口 + 一个本地服务（Electron）
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

## 对话

- **接着聊**：每次运行都把整条会话（上一轮的问与答、调过哪些工具、工具结果）带给模型，
  不再是一句一孤立。历史按 40 条 / 8 万字符裁剪，且不会留下拦腰截断的 tool 结果。
- **自动标题**：新会话拿第一句话当标题（只取第一行，超过 24 字截断），侧栏不再一排「新对话」。
- **改名**：点顶栏标题就地编辑，Enter 保存、Esc 取消。
- **删除**：侧栏会话悬停出 ×，确认后连消息、运行、事件一起删（外键 cascade）。
- **搜索**：⌘K 聚焦搜索框，按标题实时过滤；回车跳到第一条。`?q=关键词` 也能直接带过滤打开。
- **接着做**：运行失败 / 被取消 / 到步数上限时，回答下面会出现一条「接着做」。
  它不接受重打提示词，直接在当前会话的历史上再跑一轮（`POST /v1/runs/:id/continue`）：
  失败时默认追加「接着刚才的做，不要从头开始。」，取消时追加「继续。」，
  也可以带 `instruction` 换成自己的说法。代价是一次配额，跟正常运行一样。

## 技能

侧栏「技能」：一整段可挂载的规则，挂上之后**每次运行都拼进系统提示**。

- 四个内置：代码审查 / 先写测试 / 只读模式 / 说人话（代码里写死，userId 为 null，只能关不能删）；
- 自建技能可编辑可删；挂载状态存在 `users.settings.enabledSkills`（按 slug）；
- 最多同时挂 3 个、每个截 1500 字，避免把上下文吃光；
- 顺序：系统提示 → 已挂载的技能 → 记忆 → 会话历史。

**技能可以收窄工具集**：技能声明 `tools: [...]}` 后，挂上它这次运行只能用这些工具
（多个技能同时声明就取交集，最严格的那个说了算），系统提示里也会写明「本次只允许哪些工具」。
内置的「只读模式」就是 `read_file / list_dir / grep` —— 挂上之后模型连 `write_file` 都看不见，
硬要调用会被挡回来并留一条失败记录。

**能力边界**：技能只能收窄工具，**不能新增工具**。工具集本身固定七个，
要加能力得先加工具，再让技能去限制它。

## 记忆

侧栏「记忆」：四类跨会话的东西 —— 关于我 / 偏好纠正 / 项目 / 参考。

- 增删改查都在界面里（新建表单、卡片列表、删除），四类 kind 有中文标签。
- **记忆真的进上下文**：每次运行拼系统提示时会带上一段「用户的记忆（跨会话）」，
  最多 20 条、每条正文截 200 字；和当前指令冲突时以当前指令为准。
- 记忆不进对话记录，只在系统提示里出现 —— 换会话也生效，删掉就立刻不生效。

## 自动化

侧栏「任务与自动化」：一条 cron + 一句任务描述，到点自己起一个运行。

- **定时**：标准五段 cron（分 时 日 月 周），支持 `*`、`*/15`、`9-18`、`8,20`；
  界面把常见写法翻成人话（`0 8 * * *` → 每天 08:00）。
- **巡检**：服务每 30 秒看一眼，`selectDue` 保证同一分钟只触发一次（容忍 tick 抖动，
  `lastRunAt` 落在这一分钟内就不再跑）。
- **跑起来就是开个会话**：标题「晨间简报 · 11/5」，内容和手动发一句没区别，
  走的还是同一套配额、降级、审批、可重放。
- **立即运行** / **暂停** / **删除** 都在卡片上；配额用超且不允许降级时，这次触发静默跳过。

## 工具与审批

一个运行 = 若干轮「模型说 → 工具做 → 结果回给模型」。循环在 `packages/core/src/agent.ts`，
最多 6 轮，到上限就停并告知用户，不无限自转。

| 工具 | 风险 | 要审批 | 说明 |
| --- | --- | --- | --- |
| `read_file` | low | 否 | 读工作区里的文本文件，超过 120KB 截断 |
| `list_dir` | low | 否 | 列目录，最多 200 项 |
| `write_file` | high | **是** | 写文件，自动建目录 |
| `shell` | high | **是** | 跑命令，默认 20s 超时，输出截断 8KB |
| `grep` | low | 否 | 正则搜内容，跳过 node_modules/.git/dist 与二进制，输出到上限即停 |
| `apply_patch` | high | **是** | 按「原文 → 新文」精确替换；原文必须唯一命中，改不了歧义处 |
| `http` | medium | **是** | 发请求，返回状态码与响应体（截断 200KB）；默认**不许打内网** |

三条纪律：

1. **路径锁在工作区**：任何 `../` 解析到工作区外的路径直接拒，连读都不给读；
2. **要不要审批由风险决定**，不交给模型判断；模型只能调注册过的工具，参数一律 zod 校验后才执行；
3. **自毁类命令连审批都不给**：`rm -rf /`、`mkfs`、`dd of=/dev/`、`shutdown` 一律硬拦。

审批流：

```
运行 ──▶ 模型要求 write_file
          └─▶ 状态变 waiting_approval，推 run.approval_requested
                ├─ 允许这次 ──▶ 执行 → run.tool_result → 模型继续
                ├─ 允许这类 ──▶ 执行，并把这个工具写进设置，之后同名工具不再问
                ├─ 拒绝 ──▶ 不执行，告诉模型「用户没允许」→ 模型换个做法
                └─ 10 分钟无人理 ──▶ 自动拒绝，运行照样收尾，不会烂在那里
```

「允许这类」落在 `users.settings.approvedTools`，重启后仍然有效；
设置页能看见授权了哪些工具，也能一键撤销。

`waiting_approval` 只是等一次点击，不是失败；**被拒也不算失败**——模型会读到拒绝理由并换路子。

**重启是分两种处理的**：

- `queued` / `running` 标成 `failed`（“服务重启，这次运行被中断了”）——没有进程在推事件流，救不回来；
- `waiting_approval` **接着等**：审批请求早已落库，重启后重新挂起同一个调用，
  你点「允许」它就接着执行工具、把结果塞回历史、让模型继续往下说。
  界面刷新时通过 `GET /v1/threads/:id` 拿到 `latestRun` 与待批调用，自动把这条运行接回来看。

## 界面

界面是 **一个自包含 HTML**（`apps/web/index.html`，样式与脚本全内联，不引任何外部资源），
由服务端在 `GET /` 直接吐出，所以和 API 同源、没有跨域问题；不装东西，双击也能开。

**界面用的是设计稿的样式表本身，不是照着重写一遍。** `design.html` 里那段 `<style>`（Apple HIG 令牌、
`.side` / `.nav-item` / `.topbar` / `.msg` / `.tool` / `.composer` / `.ctx` 这些类和几何）被整段同步进来：

```bash
node scripts/sync-design.mjs <design.html 路径>   # 只替换 ==DESIGN-CSS-START/END== 之间的内容
```

所以在设计稿里改颜色、改圆角、改间距，跑一次同步，界面跟着变。

**审批卡已经画进设计稿**（`.gate` / `.gate-head` / `.gate-row` / `.gate-tip` / `.gate-acts` / `.gate-res`，
两个状态：等你确认、已拒绝），界面直接用这组类，不再自己发明。剩下三块（思考折叠、降级提示、
工具状态标签）还在应用层，属于纯展示，暂不进设计稿。

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

**设置页**（侧栏「设置」）展示的全是这台机器上真实生效的值：主题、标准/快档模型与熔断状态、
计划与用量（次数制，带进度条）、「用超了怎么办」开关、已挂载工具及风险、事实源与工作区。
那个开关是真会落库的（`users.settings`），改完 `/v1/usage` 立刻跟着变。

**这一轮只做桌面**（1440 基准，设计稿也是按桌面画的）。不为手机做布局、不写移动端覆盖；
设计稿样式表里的断点（≤1180 收右栏、≤980 抽屉）随样式表免费带着，能兜住但不打磨。

## 桌面壳

`apps/desktop` 是个壳，不是第二套界面：它只负责开窗口，界面还是 `/` 那份单文件。

```bash
pnpm --filter @rakko/desktop build
pnpm --filter @rakko/desktop start        # 窗口 1440×900，最小 1080×720
pnpm --filter @rakko/desktop smoke        # 无人值守冒烟：加载 → 截图 → 打印标题 → 退出
pnpm --filter @rakko/desktop icons        # 从 build/icon.svg 生成 16–512 与 icon.ico
pnpm --filter @rakko/desktop pack:win     # 出 NSIS 安装包到 release/
```

打包要点：

- 服务打成一个 ESM 单文件 `build/server.mjs`（esbuild，3.1MB），和 `migrations`、`web` 一起进
  `resources/`；壳用 `RAKKO_WEB_DIR` / `RAKKO_MIGRATIONS_DIR` 指过去，所以离线也能起；
- 图标按设计稿分工：主 mark 是 C 环，**≤32px 换成爪印**（环 + 点在 16px 会糊成一团），
  16/24/32/48/64/128/256/512 一次生成，Windows 用 `icon.ico`；
- 配置放在 `%APPDATA%Rakko.env`（壳会读），打包后默认工作区是 `%APPDATA%Rakkoworkspace`，
  不往安装目录写文件；
- 单实例锁：双击两次只开一个窗口，第二个直接退出并让第一个前置；
- 窗口大小/位置记在 `%APPDATA%Rakkowindow-state.json`，换过屏幕会退回居中而不是丢到看不见的地方;
- 内网拉不到 GitHub 时给 bins 镜像：`ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/`。

**仍未做**：代码签名与公证、自动更新、托盘/菜单、macOS 与 Linux 的产物。

启动顺序：先探 `/health`，服务没起就用 Electron 自带的 node
（`ELECTRON_RUN_AS_NODE=1`）把 `apps/server` 拉起来，等健康检查通过再开窗口；
关窗顺手杀掉子进程。外链一律交给系统浏览器，窗口里只有自己的界面。

双击打开的 app 没有 shell 环境变量，所以壳会自己读 `.env`（`apps/desktop/.env` 或仓库根），
显式传入的环境变量优先。冒烟会把窗口真实渲染的内容截一张图（`RAKKO_SMOKE_SHOT` 可指定路径），
所以「页面加载成功」和「真的画出东西了」是两件事，这里验的是后者。

**还没做**：打包成安装包、签名、自动更新。这一轮只是「能双击开」。

## 自己改自己（dogfood）

2026-11-05 第一次让 agent 在本仓库里干活：任务写死成五步（grep 找函数 → 读 quota.ts →
apply_patch 加一个纯函数 → 补测试 → 跑测试）。第一轮崩在四个地方，修完第二轮 41 秒通过：

| 崩在哪 | 现象 | 修法 |
| --- | --- | --- |
| 没有系统提示 | 模型不知道是 Windows、不知道工作区在哪，写了 `cd /home/user/rakko && pnpm …`，退出码 1 | 新增 `buildSystemPrompt()`：系统、工作区、shell 语义、工具规则、干活纪律、用中文 |
| shell 不认错的 cd | 命令整个失败，白烧一轮 | `normalizeCommand()` 忽略不存在的 `cd`，并在输出里说明 |
| 默认步数 6 太紧 | 改完没机会验证，运行却标 `succeeded`，答案是半句话 | 默认 12；到上限把原因写进 `run.error`，流里提示「任务可能没做完」 |
| **包级 `pnpm test` 不 build** | 跑的是旧 dist，改了源码也可能「绿」 | 每个包 test 改成 `pnpm build && node --test …` |

最后一条最危险：agent 会信测试结果。修完第二轮：3 次审批、41 秒、51 条测试全绿、
用中文给出改动摘要，产物在分支 `dogfood/agent-run`。

### 第二轮：修一个真 bug

任务换成「并发写消息会撞唯一索引」。它的流程是对的：先跑测试看红 → 读源码 →
写复现测试（并发 5 条，直接查库验证 seq）→ 改成「撞 23505 就重试 5 次」→ 测试转绿。
89 秒、4 次工具调用、23 条测试全绿。

但我把它压到 **20 并发** 就露馅了：重试版本只成功 16/20，丢了 4 条。
重试不是并发正确性，只是把撞车概率调低。最终改成会话行锁
（事务里 `SELECT … FOR UPDATE` 锁住 thread 行），5 / 20 / 40 并发全部正确。

这一轮还暴露两个自己的问题：`recoverOrphans` 是全局扫的（测试一调就会误伤正在跑的运行），
以及成功的运行会留着历史 error。都修了。

## 任务卡（验收不靠嘴说）

让 agent 干活时，最大的坑不是它不会写代码，而是**「做完了」由它自己定义**。
任务卡把「活」和「怎么算做完」写在同一个文件里，执行器只认卡，不认它的自评。

```bash
pnpm task                              # 列出所有任务卡
pnpm task quota-export --dry           # 只看拼好的提示（含验收标准）
pnpm task quota-export                 # 跑：自动审批 + 独立验收 + 写报告
pnpm task quota-export --check-only    # 不跑 agent，只复检验收
pnpm task quota-export --update-snapshots   # 确认行为变更后，重写快照基线

pnpm task bootstrap            # 换机器 / 丢了资产：从远端恢复并校验校验和
pnpm task bootstrap --from <git url | 目录>
pnpm task verify               # 只校验当前资产
pnpm task seal                 # 确认改动后重写清单（发布前）
```

**验收资产在仓库外**：`~/.rakko-acceptance/`（它自己是个 git 仓库，路径可用 `RAKKO_ACCEPTANCE_DIR` 覆盖）。

```
~/.rakko-acceptance/
  checks/      验收脚本（并发压测、行为断言……）
  snapshots/   行为快照基线
  reports/     每次运行的报告（不进 git）
```

agent 的文件工具锁在工作区里，读这个目录会直接 `路径越界` —— 实测：

```
→ read_file {"path":"C:\Users\chiaki\.rakko-acceptance\checks\quota-export.mjs"}
← fail 路径越界：… 不在工作区 C:\Users\chiaki\Desktop\Rakko
```

之前它读过 `tasks/checks` 并**照着检查脚本改产品文案**去迎合测试；挪出工作区之后这条路就断了。

**资产有校验和**：验收目录里有一份 `acceptance.json`，记录 `checks/` 与 `snapshots/` 每个文件的 sha256
（按换行归一化算，CRLF / LF 不影响）。每次跑任务卡之前都会校验：清单缺了、文件少了、内容变了，
一律拒绝开跑并告诉你怎么办。换机器时用 `pnpm task bootstrap` 从 git 远端（或目录）恢复：

```
从 git 恢复：file:///…/.rakko-acceptance
已恢复 3 个文件到 ~/.rakko-acceptance
✓ checks/concurrent-append.mjs
✓ checks/quota-export.mjs
✓ snapshots/quota-export.json
清单校验通过
```

改一个字节再校验，会立刻红；带着被改过的资产跑任务卡，直接拒绝。

一张卡长这样（`tasks/<id>.task.json`）：

```json
{
  "id": "concurrent-append",
  "title": "同一会话并发写消息不丢数据",
  "prompt": "给 agent 的活……",
  "repro": ["pnpm --filter @rakko/server test --test-name-pattern 并发"],
  "accept": [
    { "name": "20 / 40 并发都正确", "cmd": "node tasks/checks/concurrent-append.mjs", "expectExitCode": 0 },
    { "name": "server 测试全绿", "cmd": "pnpm --filter @rakko/server test", "expectExitCode": 0 }
  ],
  "boundaries": {
    "concurrency": [20, 40],
    "mustNotChange": [
      { "file": "packages/db/src/schema.ts", "contains": "uniqueIndex('messages_thread_seq_uq')" }
    ]
  },
  "autoApprove": ["read_file", "list_dir", "grep", "apply_patch", "shell"]
}
```

四条规矩：

1. **验收由执行器跑**（`accept`），agent 自己写的测试再绿也不算过；
2. **边界写死**（`boundaries.concurrency`），上次那个「重试 5 次」就是只测了 5 并发才漏的；
3. **`mustNotChange` 机检文本**（文件里必须还包含某段文本）—— 防止它改文案迎合测试；
4. **`boundaries.snapshots` 机检行为**（调用真实导出，比对输入输出快照）—— 文本没动、行为变了也能抓到。

快照怎么用：卡里写 `{ module, export, cases: [{ args }] }`，第一次跑 `--update-snapshots` 建基线；
之后任何一次行为变化都会红并打印「第 N 例：之前 → 现在」。实测把 `decideQuota` 的降级理由从
「改用快速模型」改成「换成快速模型」，验收命令与文本守卫全绿，快照红 —— 这正是它要抓的。

报告落在 `~/.rakko-acceptance/reports/<id>-<时间>.json`，有任何一项不达标就以 1 退出，能直接进 CI。

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
- **事件先落库再推送**，SSE 断线重连只靠 `Last-Event-ID` 续上（服务端按事件序号过滤补发，不是重放全部）；
- **会话是可重放的**：`messages` 有 `kind` + `payload`，`text / tool_call / tool_result / approval / approval_decision / notice`
  六种记录按 `seq` 排；助手文字分「段」落库（遇到卡片就封口），重开会话时工具卡与审批卡回到原位，
  运行失败也不会丢掉已经说出口的话；
- **配额只认 `usage_ledger` 的求和**，用户改不动这个数；
- 迁移目录按模块相对路径定位，从哪个目录起服务都不会找错。

## 接口（M0）

```
GET  /health                                   服务、provider、模型、熔断、工具、等待中的审批
GET  /v1/usage                                 配额（次数制，来自 usage_ledger）
GET  /v1/skills                                技能列表（含 enabled）
POST /v1/skills                                新建技能（可带 tools 限制）
PATCH /v1/skills/:id                           改内容，或 { enabled } 挂载/关闭
DELETE /v1/skills/:id                          删自建技能（内置给 409）
GET  /v1/memories                              记忆列表（按更新时间倒序）
POST /v1/memories                              记一条（kind / title / description / body）
PATCH /v1/memories/:id                         改
DELETE /v1/memories/:id                        删
GET  /v1/automations                           自动化列表（含 human 描述）
POST /v1/automations                           新建（名字 / cron / 任务）
PATCH /v1/automations/:id                      改名、改时间、启用暂停
DELETE /v1/automations/:id                     删除
POST /v1/automations/:id/run                   立即跑一次
GET  /v1/settings                              用户设置（degradeOnExceed）
PATCH /v1/settings                             改设置（目前只认 degradeOnExceed）
GET  /v1/threads                               会话列表
PATCH /v1/threads/:id                          改名（title，先 trim 再判空）
DELETE /v1/threads/:id                         删会话（消息/运行/事件一起删）
POST /v1/threads                               新建会话
GET  /v1/threads/:id                           线程 + 最近一次运行 + 待批调用（刷新后据此接着看流）
GET  /v1/threads/:id/messages                  会话消息（含 kind/payload，工具与审批可重放）
POST /v1/runs                                  发起运行（202，返回 tier/degraded；配额不足时 429）
GET  /v1/runs/:id                              运行状态 + pendingApprovals
POST /v1/runs/:id/continue                     接着已停下的运行继续（失败/取消/到上限）
GET  /v1/runs/:id/events                       SSE 事件流，带 id；重连带 Last-Event-ID 只补没看过的
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
- **http 默认不许打内网**（localhost / 10. / 192.168. / 169.254 等），要放开得显式打开 `RAKKO_HTTP_ALLOW_PRIVATE`。
- **审批只能 allow / deny**，不允许在审批时改参数 —— 那等于让人替模型写代码。

## 下一步

1. 界面补齐：会话重命名/删除、工具卡里直接看 diff、审批卡支持“允许这一次 / 允许这类工具”。
2. 工具补齐：`grep`、`apply_patch`、HTTP 请求，以及“同一工具连续失败就换策略”的退让逻辑。
3. 审批持久化：现在等待中的审批只在内存里，重启即作废。要支持隔天回来再批，得落库。
4. 桌面壳（Electron）接上同一套 `packages/protocol` 与 tokens；移动端（Expo）暂缓。
5. 设置页按 `design.html` 的 AURA 稿落地（计划与用量、模型、连接器）。
6. 自动化、技能、记忆三张表已有 schema，等对应功能进 M2 再接上。
