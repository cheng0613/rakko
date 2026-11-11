# Rakko

pi 的桌面 GUI。纯本地，用户自带 key，不做 SaaS。

---

## 现在是什么状态

**P0 骨架阶段。** 能开窗口、能渲染布局树、有完整的类型与测试基础设施。**还不能对话。**

已完成：

- pnpm workspace + TypeScript 严格模式
- Electron 三进程（main / preload / renderer）能启动
- 布局树（递归 split/pane）与 19 个测试
- `models.json` 生成与四字段校验（32 个测试）
- 系统提示追加文件的写入与回读校验
- 权限档定义与保护性测试
- preload 白名单桥

未完成（P0 剩余）：

- PiHost：spawn `pi --mode rpc` 与 JSONL 收发
- translator：pi 事件 → AgentEvent
- CompatProxy：loopback 代理与 key 替换
- PermissionGate：三档审批
- 对话页 / 首页 UI（等 OpenDesign 稿）

---

## 快速开始

```bash
pnpm install
pnpm verify        # typecheck + test + build
pnpm dev           # 开发模式启动
```

要求：node >= 22，pnpm 12.14.0。

---

## 目录

```
packages/
  shared/    类型、IPC 契约、AgentEvent、权限档、branding
  core/      pi 集成（models.json / 提示词）、后续放会话与权限（不 import electron）
apps/
  desktop/   Electron 主进程 + preload + renderer
```

---

## 关键约束

完整清单见 `AGENTS.md`。最容易踩的两条：

**1. 系统提示的追加文件必须回读校验。**
实测 pi 1.4.0：`--append-system-prompt` 指向不存在的文件时**静默把它当字面文本**，不报错、退出码 0。用户看到的是"人格不对"，实际是路径错了。

**2. `models.json` 的 `cost` 必须四字段齐全。**
缺任何一个（`input`/`output`/`cacheRead`/`cacheWrite`）都会让整个文件校验失败、**所有模型消失**。

这两条都有测试守着，改动前先读 `packages/core/src/pi/__tests__/`。

---

## 提交

```bash
pnpm verify
git commit -m "feat(scope): 中文描述"
```

格式见 `AGENTS.md` 第七节。scope 用功能域（`chat`/`session`/`model`/`proxy`/`layout`），不用目录名。

---

## 与 Cindy 的关系

架构参考 `makecindy/cindy`（Apache-2.0）。借鉴的是**设计决策与踩坑结论**，代码是自己的：

- 三层解耦：共用主体不 import electron，平台能力走端口注入
- 统一 AgentEvent，UI 不直接消费 pi 事件
- 布局树：`chat-main` 恰好一个，面板身份用 `panelKind`
- 权限档从严到宽，`[0]` 最严

不照搬：多 harness 抽象（只做 pi）、多端互联、IM、SaaS 商业层。
