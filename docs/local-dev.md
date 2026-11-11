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
