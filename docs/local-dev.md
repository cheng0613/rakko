# 本地开发配置（不进仓库）

这个目录下的 `.env.local` 已被 `.gitignore` 忽略。**key 不要写进任何被跟踪的文件。**

## 用均瑶内网网关跑起来

PowerShell：

```powershell
$env:RAKKO_BASE_URL="https://d-openai.juneyaoair.com/llm/v1"
$env:RAKKO_MODEL="deepseek-v4-flash"
$env:RAKKO_API_KEY="<你的 key>"
$env:RAKKO_PROVIDER_ID="juneyao"
$env:RAKKO_PROVIDER_NAME="均瑶内网网关"
pnpm dev
```

bash / Git Bash：

```bash
export RAKKO_BASE_URL="https://d-openai.juneyaoair.com/llm/v1"
export RAKKO_MODEL="deepseek-v4-flash"
export RAKKO_API_KEY="<你的 key>"
pnpm dev
```

## 实测可用的模型（2026-11-11）

| 模型 id | 状态 | 备注 |
|---|---|---|
| `deepseek-v4-flash` | 推荐 | 正文正常，工具调用正常，响应快 |
| `deepseek-v4-pro` | 可用 | 正文正常 |
| `kimi-k2.7-code` | 可用 | 正文正常 |
| `qwen3.5-plus` | 可用 | 会自称 OpenAI，模型身份不可靠 |
| `glm-5.2` | 需注意 | `max_tokens` 小于约 500 时全被推理吃掉，正文为空。建议 `RAKKO_MAX_OUTPUT=8192` |
| `minimax-m3` | 需注意 | 正文自带裸 `<think>` 标签，需 UI 侧剥离 |

完整模型列表：`curl -H "Authorization: Bearer $KEY" https://d-openai.juneyaoair.com/llm/v1/models`

## 验证链路

```bash
# 只验证 pi + proxy + 上游，不开界面
RAKKO_API_KEY="<key>" pnpm e2e:pi
```

期望看到：
- `env 里含真 key: false`
- proxy 日志 `FORWARD POST /v1/chat/completions -> https://.../llm/v1/chat/completions`
- 上游 200，pi 输出正常回答

## 常见问题

**`Connection error`**
proxy 没起来或端口被占。检查 `[proxy] 已启动` 日志。

**上游 404**
路径拼错了。我们的 `buildUpstreamUrl` 会去掉 base 与请求路径的重叠段，
`https://host/llm/v1` + `/v1/chat/completions` → `https://host/llm/v1/chat/completions`。
如果你的上游是别的形状，`packages/proxy/src/__tests__/server.test.ts` 里有对应用例。

**模型返回空正文但 usage 有值**
全花在 `reasoning_tokens` 上了。加大 `RAKKO_MAX_OUTPUT`。

## 内置 pi 运行时

应用内置一份裁剪过的 pi（约 94MB），不依赖用户机器上装没装 pi。

```bash
pnpm pi:prepare    # 从系统 pi 裁剪出 resources/pi（138MB → 94MB）
pnpm pi:verify     # 验证产物能跑完整闭环
```

`pi:prepare` 会去这几个地方找系统 pi：环境变量 `RAKKO_PI_ENTRY` →
volta → npm 全局。找不到就报错，需要先 `npm i -g @mariozechner/pi`。

裁剪掉了这些用不到的 provider SDK（共 44MB）：
`@anthropic-ai`、`@google`、`@aws-sdk`、`@smithy`。
保留了 `openai`（25MB）——`openai-completions` 协议的核心，不敢裁。

### 出安装包

```bash
cd apps/desktop
pnpm dist:full
```

产物在 `release/win-unpacked/`，约 304MB（含 94MB 运行时）。

`dist:full` 做四件事：裁剪运行时 → electron-vite 构建 → electron-builder 打包 →
**补拷贝 node_modules**。

最后一步不能省：electron-builder 对 `extraResources` / `extraFiles` 的
`from` 目录会**自动排除 `node_modules`**（它假设那是应用自己的依赖）。
而 pi 加载 `.ts` 扩展需要 `jiti`，缺了就直接起不来，
报 `Failed to load extension: Cannot find module 'jiti'`。

### 为什么必须是 Electron 35+

pi 1.4.0 用了 Node 22 才有的 API：`module.enableCompileCache()` 和 `fs.globSync()`。
Electron 33 内置 Node 20.18，两个都没有，pi 会直接 SyntaxError 退出。

试过两个绕法都不行：`ELECTRON_RUN_AS_NODE` 仍然缺 API；写 shim 跳过
`enableCompileCache` 之后又撞上 `fs.globSync`。

所以锁 Electron 35+（Node 22.16）。升级时记得重编原生模块，
ABI 会变（Electron 33 = 130，35 = 133）：

```bash
npx @electron/rebuild -f -w better-sqlite3 -v 35.7.5 --arch x64
```

### 排查

打包版起不来时，先确认这几件事：

```bash
cd release/win-unpacked
ELECTRON_RUN_AS_NODE=1 ./Rakko.exe resources/pi/bundle/cli.js --version
# 期望输出 1.4.0
```

再检查应用日志里的三行：
- `pi 入口 { entry, version, source: 'bundled' }` —— entry 必须指向
  `resources/pi/bundle/cli.js`，不是系统路径
- `node 二进制 { path, version, source }` —— 打包版应该落到
  `electron-run-as-node` 或系统 node
- `pi stderr` —— 有报错就看这里，别只看「进程已退出 code=1」
