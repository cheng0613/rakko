# AGENTS.md

> 给在这个仓库里干活的 agent 看的。人类读者先看 `README.md`（如果有）。
> 冲突时以本文的「不变量」为准。

---

## 一、这是什么

**Rakko** —— pi 的桌面 GUI。纯本地，用户自带 key，不做 SaaS。

- 产品名一律 `Rakko`（全大写 R）
- pi 原生工具与提示词里的自称**保留不动**（不改 pi 本体）
- 首期只做桌面端，不做移动端 / Web / 多端互联 / IM

---

## 二、锁定的依赖

| 依赖 | 版本 | 说明 |
|---|---|---|
| pi | **1.4.0** | 唯一基座 harness。不跟随上游自动升级 |
| node | >= 22 | |
| pnpm | 12.14.0 | |

**pi 的获取方式**：随包内置（不从 CDN 下载）。裁剪到约 90MB，保留 `dist/bundle/` 与必要的 `node_modules`。

**升级 pi 前必须**：跑 `pnpm test` 全套契约测试。pi 的行为会在版本间变化（实测：1.4.0 里 `--append-system-prompt` 指向不存在的文件时**静默当字面文本**，不报错）。

---

## 三、命名约定

| 位置 | 写法 |
|---|---|
| 产品显示名 | `Rakko` |
| 包名 | `@rakko/*` |
| 环境变量前缀 | `RAKKO_` |
| appId | `app.rakko.desktop` |
| 目录 | `project-rakko` |

产品名不硬编码在组件里，统一从 `packages/shared/src/branding.ts` 读。

---

## 四、进程与目录

```
Electron Main
├── PiHost          spawn(node, bundle/cli.js, --mode rpc)，stdin/stdout JSONL
├── CompatProxy     loopback 127.0.0.1，持有真 key，字节级 pipe
├── SessionRegistry 会话生命周期
├── PermissionGate  三档权限
└── ProviderStore   用户 key（safeStorage 加密）

Renderer（React）   表达状态与意图
Packages（业务主体） 不 import electron
```

```
packages/
  shared/     类型、IPC 契约、AgentEvent、branding
  core/       pi 集成、会话、项目、权限、用量（不 import electron）
  proxy/      CompatProxy（可独立测试）
apps/
  desktop/    Electron 主进程 + preload + renderer
resources/
  pi/         内置 pi 运行时
  model-presets.json
```

---

## 五、不变量（13 条，改动时不得破坏）

1. **权限档顺序** `[ask, auto, bypassPermissions]`，`[0]` 最严。
   无人值守链路在「显式档不被支持」时回落 `[0]`；顺序错了会把更严选择**静默放宽成完全访问**。

2. **spawn env 逐字节稳定**。同一 `sessionId` 重建时 env 必须完全相同。
   禁止 `randomBytes` / 时间戳 / 计数器进入 spawn env —— 会毁掉断链保活语义。
   会变的值必须确定性派生（如 `HMAC(进程级key, sessionId)`）或走非 env 通道。

3. **`--no-approve` 必传**，不读项目 `.pi/settings.json`，不传 `--approve`。

4. **auto 档 fail-closed**。分类抛错 / 无 resolver 一律不放行。

5. **bash 超时**：默认 300s、上限 1800s。缺省或非正数用默认；超上限 fail-fast（参数错误，不是超时）。

6. **凭证路径判定三处同口径**。改一处必须同步改其余两处。

7. **系统提示用 `--append-system-prompt`**，超过 **2000 字符必须走文件路径**。
   实测：内联在约 7,700 字符处报「命令行太长」；2,000 是保守值。

8. **append 文件写后必须回读校验**。
   实测 pi 1.4.0：文件不存在时**静默把路径当字面文本**塞进 system prompt，不报错、退出码 0。
   必须：写临时文件 → 回读比对 → 原子改名 → 断言绝对路径且大小 > 0。任一不满足，**拒绝启动 pi**。

9. **`models.json` 的 `cost` 必须四字段齐全**：`input` / `output` / `cacheRead` / `cacheWrite`。
   实测：缺一个字段 → 整个文件校验失败 → **所有模型消失**。

10. **`chat-main` 恰好一个**，始终可见、不可关闭、最小宽度 400px。

11. **共用主体不 import electron**。平台能力（窗口、钥匙串、对话框）由主体声明端口，平台注入实现。

12. **proxy 响应必须字节级 pipe，禁止缓冲**。SSE 流式延迟是红线。

13. **用户 key 不进入 spawn env、不落明文磁盘**。
    key 由 proxy 内存持有；`models.json` 写 `$RAKKO_PI_API_KEY`，env 里只放占位值。

---

## 六、已知的 pi 行为（实测，不是猜测）

这些是踩过的坑，写下来避免重复踩：

| 行为 | 实测结论 |
|---|---|
| `models.json` 的 `apiKey` 支持 `$ENV_VAR` 插值 | ✅ 生效，pi 不做格式校验，字面值直接发出 |
| env 变量缺失时 | ✅ 明确报错 `No API key found for <provider>`，不发请求 |
| `--append-system-prompt` 传文件路径 | ✅ 有效，相对/绝对/含空格/含中文都行 |
| `--append-system-prompt` 传不存在的路径 | ❌ **静默当字面文本**，见不变量 8 |
| 内联文本约 7,700 字符 | ❌ 报「命令行太长」（Windows） |
| 28KB 文件路径 | ✅ 完整送达 |
| `openai-completions` 请求体字段 | `model, messages, stream, prompt_cache_key, prompt_cache_retention, stream_options, store, max_completion_tokens` |

**transform 链必须用白名单删除，不能白名单保留** —— pi 会随版本新增字段。

---

## 七、提交前必须做

```bash
pnpm verify     # typecheck + test + build，全绿才能提交
```

提交格式见 `docs/COMMITS.md`。要点：

```
<type>(<scope>): <中文描述>

<为什么 / 改了什么 / 没做什么 / 怎么验证的>

Assisted-by: Cindy (https://cindy.app)
```

- type：`feat` `fix` `refactor` `chore` `docs` `test`
- scope 是**功能域**不是目录：`chat` `session` `project` `permission` `model` `proxy` `layout` `tool` `usage`
- 技术层：`core` `proxy` `shared` `desktop` `renderer` `ipc`

---

## 八、不要做的事

| 不要 | 为什么 |
|---|---|
| 绕过 pi 直接调上游 | 所有流量必须经 CompatProxy，否则 key 会进 spawn env |
| 在 translator 里直接 `webContents.send` | 事件流必须是可订阅的 pub/sub，为将来多端留口 |
| 硬编码产品名 `Rakko` 到组件 | 从 `branding.ts` 读 |
| 假设 pi 会报错 | 实测有静默降级（不变量 8） |
| 声称「已验证」但没跑 | 会被要求出示输出 |
| 用 `--no-verify` 绕过提交检查 | 改 message，不要绕过 |

---

## 九、进度汇报口径

**能跑才说能跑，没测过的标「未验证」。**

- 说「测试通过」必须给数量
- 说「实测通过」必须给命令与关键输出
- 不确定的标「未验证」，不说「应该可以」
