// 用真实的 PiHost 跑一次端到端对话（真 pi 1.4.0 + 假网关）
// 运行：npx tsx host-e2e.ts
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiHost } from "@rakko/core";
import { resolvePiEntry } from "@rakko/core";
import { buildPiEnv } from "@rakko/core";
import { writeModelsJson } from "@rakko/core";
import { writeAppendPrompt, assertAppendPromptUsable } from "@rakko/core";
import type { AgentEvent, ProviderConfig } from "@rakko/shared";

const PORT = 52880;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "rakko-e2e-"));
const agentHome = path.join(work, "agentHome");
const cwd = path.join(work, "workspace");
fs.mkdirSync(agentHome, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(path.join(cwd, "hello.txt"), "你好，Rakko\n");

// 假网关：流式返回固定文本
const gwSrc = `
const http=require("http");
http.createServer((req,res)=>{
  if(req.url.endsWith("/models")){
    res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify({object:"list",data:[{id:"probe-model"}]}));return;
  }
  if(/chat\\/completions$/.test(req.url)){
    let b="";req.on("data",c=>b+=c);req.on("end",()=>{
      res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache"});
      const base={id:"x",object:"chat.completion.chunk",created:1,model:"probe-model"};
      for(const t of ["读","到","了","hello.txt"]){
        res.write("data: "+JSON.stringify({...base,choices:[{index:0,delta:{content:t},finish_reason:null}]})+"\\n\\n");
      }
      res.write("data: "+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:12,completion_tokens:4,total_tokens:16}})+"\\n\\n");
      res.write("data: [DONE]\\n\\n");res.end();
    });return;
  }
  res.writeHead(200,{"content-type":"application/json"});res.end("{}");
}).listen(${PORT},"127.0.0.1");
`;
const gwPath = path.join(work, "gw.js");
fs.writeFileSync(gwPath, gwSrc);
const gw = spawn(process.execPath, [gwPath], { stdio: "ignore" });

const log = (level: string, msg: string, meta?: unknown) => {
  console.log(`[${level}] ${msg}`, meta ? JSON.stringify(meta).slice(0, 300) : "");
};

async function main(): Promise<void> {
  await new Promise((r) => setTimeout(r, 1200));

  // 1. 解析 pi
  const pi = await resolvePiEntry();
  console.log("✓ pi 入口:", pi.entry);
  console.log("  pi 版本:", pi.version, "来源:", pi.source);

  // 2. 写 models.json
  const providers: ProviderConfig[] = [
    {
      id: "probe",
      name: "Probe",
      api: "openai-completions",
      baseUrl: `http://127.0.0.1:${PORT}/v1`,
      models: [
        {
          id: "probe-model",
          name: "Probe",
          contextWindow: 128000,
          maxOutput: 4096,
          capabilities: { supportsTools: true, supportsImage: false, supportsThinking: false },
          cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
        },
      ],
    },
  ];
  await writeModelsJson(agentHome, {
    proxyBaseUrl: `http://127.0.0.1:${PORT}/v1`,
    providers,
  });
  console.log("✓ models.json 已写入");

  // 3. 写 append prompt 并校验
  const prompt = await writeAppendPrompt(agentHome, ["你是 Rakko，一个桌面助手。"]);
  await assertAppendPromptUsable(prompt.absolutePath, prompt.bytes);
  console.log("✓ append prompt:", prompt.bytes, "字节, hash:", prompt.hash);

  // 4. 构造 env
  const env = buildPiEnv({ sessionId: "e2e-session-001", agentHome, proxyPort: PORT });
  console.log("✓ env 构造完成, key 占位:", env["RAKKO_PI_API_KEY"]);

  // 5. 启动 PiHost
  const events: AgentEvent[] = [];
  const host = new PiHost({
    nodePath: process.execPath,
    piEntry: pi.entry,
    sessionId: "e2e-session-001",
    agentHome,
    cwd,
    env,
    extraArgs: [
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
      "--no-context-files",
      "--provider",
      "probe",
      "--model",
      "probe-model",
      "--append-system-prompt",
      prompt.absolutePath,
    ],
    onEvent: (e) => {
      events.push(e);
    },
    onExit: (code, sig) => log("info", `pi 退出 code=${code} sig=${sig}`),
    log,
  });

  host.start();
  console.log("✓ PiHost 已启动");

  // 6. 握手
  const state = await host.getState();
  console.log("✓ get_state 成功, model:", (state as any)?.model?.id);

  // 7. 发 prompt
  const r = await host.prompt("读一下 hello.txt");
  console.log("✓ prompt 回执:", JSON.stringify(r));

  // 8. 等事件流走完
  await new Promise((r) => setTimeout(r, 4000));

  console.log("\n=== 收到的事件 ===");
  for (const e of events) {
    if (e.type === "text_delta") continue;
    if (e.type === "usage") {
      console.log("usage:", JSON.stringify(e.usage));
      continue;
    }
    console.log(JSON.stringify(e).slice(0, 200));
  }
  const text = events
    .filter((e) => e.type === "text_delta")
    .map((e) => (e as { text: string }).text)
    .join("");
  console.log("\n拼接出的正文:", JSON.stringify(text));

  await host.dispose();
  console.log("✓ PiHost 已停止");
}

main()
  .catch((e) => console.error("E2E 失败:", e))
  .finally(() => {
    gw.kill();
    setTimeout(() => {
      try {
        fs.rmSync(work, { recursive: true, force: true });
      } catch {
        /* Windows 文件锁，忽略 */
      }
      process.exit(0);
    }, 500);
  });
