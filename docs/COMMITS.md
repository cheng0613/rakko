# Rakko 提交规范

> 版本：1.0 · 2026-11-11
> 规则来源：参考 Cindy 的 44 条 commit 实践（那套写法是可用的），但本文只写**本仓库适用的规则**，
> 不再引用历史统计——本仓库是一次全新开始，没有值得考古的旧提交。

---

## 一、格式

```
<type>(<scope>): <中文描述>

<为什么改 / 改了什么 / 没做什么 / 怎么验证的>

Assisted-by: Cindy (https://cindy.app)
```

最小形态（纯文档可以没有正文）：

```
docs: 补 README 的快速开始

Assisted-by: Cindy (https://cindy.app)
```

---

## 二、type（只允许 6 种）

| type | 用途 |
|---|---|
| `feat` | 新功能、新能力、新页面 |
| `fix` | 修 bug（含并发、数据丢失、显示错误） |
| `refactor` | 重构，**行为不变** |
| `chore` | 构建、依赖、脚本、配置文件 |
| `docs` | 文档、README、注释为主的改动 |
| `test` | 只加或改测试，不动产品代码 |

**禁用**：`improve`、`update`、`change`、`misc`（语义模糊）。
**禁止**：`wip`、`tmp`、`测试一下` 进入主分支。

---

## 三、scope（功能域，不是目录）

### 3.1 判断顺序

```
1. 这次改动属于哪个用户能感知的功能？→ 用功能域 scope
2. 感知不到，只改一层？→ 用技术层 scope
3. 都不是（脚本、依赖）→ 省略 scope，如 `chore: 升级 electron`
```

### 3.2 功能域

```
chat        对话、消息流、composer
session     会话生命周期、恢复、中止
project     项目、工作目录、AGENTS.md 装配
permission  权限档、审批卡、自动审核
model       模型目录、供应商连接、key 管理
proxy       CompatProxy、请求转发、用量观察
layout      布局树、面板注册表
tool        内置工具、工具调用展示
usage       用量统计
teammate    伙伴（P2 阶段）
plugin      插件（P2 阶段）
```

### 3.3 技术层

```
core         packages/core 内部改动
shared       packages/shared 内部改动
desktop      Electron 主进程、窗口、打包
renderer     React 组件与样式
ipc          IPC 契约与 preload
```

### 3.4 反例

- ❌ `feat(packages/core): ...` —— 目录不是 scope
- ❌ `feat(model,proxy): ...` —— 多 scope 让筛选失效，选主功能域
- ❌ `feat(frontend): ...` —— 太泛，等于没写

**为什么按功能域**：一个 `model` 改动往往同时碰 `packages/core`、`packages/shared`、`apps/desktop`。
按目录命名 scope，跨包改动就没法归类。

---

## 四、描述行

| 规则 | 说明 |
|---|---|
| **中文** | 全仓库统一 |
| **建议 50 字符，硬上限 72** | 超过 git log 会换行。枚举包名这类可以到 72 |
| **不加句号** | |
| **动词开头** | 「加」「改」「修」「撤掉」「搬进」 |
| **说结果，不说过程** | ✅「布局树支持递归 split」 ❌「尝试修改布局实现」 |

### 破折号补充（推荐）

```
feat(layout): 布局树支持递归 split —— 任意面板可拖拽分割
fix(proxy): SSE 被缓冲导致流式卡顿 —— 改成字节级 pipe
```

前半句说做了什么，后半句说关键点。

---

## 五、正文

### 5.1 什么时候必须写

| 情况 | 是否必须 |
|---|---|
| 涉及设计取舍 | ✅ 必须 |
| 修了 bug | ✅ 必须（写复现路径与根因） |
| 影响用户可见行为 | ✅ 必须 |
| 纯文档、纯依赖升级 | ❌ 可省 |

### 5.2 四段结构

```
<为什么需要这个改动，或者说清问题现象>

<改了什么，分组列出>

<没做什么，为什么不做>          ← 最容易被漏，也最有用

<怎么验证的：实测记录、测试数量、复现命令>
```

### 5.3 范例

```
fix(core): models.json 缺 cost 字段会让所有模型消失

实测 pi 1.4.0：cost 只写了 input/output 时，pi 报

  Invalid models.json schema:
    providers.probe.models.0.cost.cacheRead: must have required properties cacheRead, cacheWrite

然后整个文件作废，所有模型消失。错误只在启动日志里，界面表现为「没有可用模型」。

- 写盘前自己校验四个字段，报出精确的 provider / model / 字段名
- 校验不通过抛 ModelsJsonError，不生成半成品文件
- 补测试：四个字段各缺一次，都必须抛错

没做「缺字段时补默认值 0」：cost 影响成本显示，猜一个值比报错更糟。

实测：4 个字段依次缺失，全部被拦下并指出具体位置。
测试 core 32 项通过。
```

---

## 六、trailer

### 6.1 `Assisted-by`（agent 参与的提交必须带）

```
Assisted-by: Cindy (https://cindy.app)
```

说明这段代码有 agent 参与。将来排查问题时，能知道哪些改动可能带着 agent 的盲区。
格式固定，不要自创变体。

### 6.2 可选

| trailer | 何时用 |
|---|---|
| `Refs: #123` | 关联 issue |
| `Reviewed-by: 名字` | 有人 review 过 |

### 6.3 破坏性变更

```
feat(ipc)!: AgentEvent 改成带 turnId

BREAKING-CHANGE: 渲染进程订阅的事件全部多一个 turnId 字段，旧 handler 会拿到 undefined
```

加 `!` **必须**在正文写 `BREAKING-CHANGE:` 说明破坏点。

---

## 七、分支与合并

### 7.1 分支命名

```
<type>/<简短说明>

feat/layout-split
fix/proxy-buffering
chore/upgrade-electron
```

### 7.2 合并策略

| 场景 | 方式 |
|---|---|
| 功能分支 → master | **squash merge**，用 PR 标题做 message |
| 紧急修复 | 直接 commit 到 master |

**squash 的理由**：功能分支里常有 "wip"、"修 typo" 这类中间提交。
squash 保证 master 上每个 commit 都完整、可检索。

### 7.3 PR 标题

**PR 标题就是 squash 后的 commit message**，按第 二 节格式写。

---

## 八、反模式

| 反模式 | 为什么不行 |
|---|---|
| 一个 commit 改多个不相关功能 | 无法 review、无法回滚 |
| 描述写"优化性能"但没说从多少到多少 | 无法验证，等于没说 |
| 修 bug 不写复现路径 | 下一个人遇到同样问题要重新查 |
| 改了行为但没写"没做什么" | 看的人不知道是漏了还是故意的 |
| 把大改动拆成 10 个 "fix" | 应该是一个 feat + 正文说明 |
| `--no-verify` 绕过检查 | 改 message，不要绕过 |

---

## 九、一句话总结

> **`type(scope): 中文结果 —— 关键点`，正文写清「为什么 / 改了什么 / 没做什么 / 怎么验证的」，agent 参与的带 `Assisted-by`。**
