// 用产品代码（@rakko/proxy）验证你的真实上游配置
// proxy 跑在独立进程里，避免 spawnSync 阻塞事件循环
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PI =
  "C:/Users/chiaki/AppData/Local/Volta/tools/image/packages/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const NODE = "C:/Users/chiaki/AppData/Local/Volta/tools/image/node/22.23.2/node.exe";
const KEY = process.env["RAKKO_API_KEY"]!;
const MODEL = process.argv[2] ?? "deepseek-v4-flash";
const BASE_URL = "https://d-openai.juneyaoair.com/llm/v1";
const PROXY_PORT = 52960 + Math.floor(Math.random() * 100);

if (!KEY) {
  console.log("缺少 RAKKO_API_KEY");
  process.exit(1);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "prod-"));
const ws = path.join(home, "ws");
fs.mkdirSync(ws);
fs.writeFileSync(path.join(ws, "notes.md"), "# 项目笔记\n\nRakko 是一个桌面 GUI，基于 pi 构建。\n");

// proxy 独立进程：直接 import 产品代码
const proxyEntry = `
import { createCompatProxy } from "${pathToFileURL(path.resolve("D:/codespace/project-rakko/packages/proxy/src/index.ts")).href}";
const p = await createCompatProxy({
  port: ${PROXY_PORT},
  resolveSession: (req) => {
    const v = req.headers["x-rakko-session-id"];
    return typeof v === "string" ? v : null;
  },
  observers: {
    log: (lv, msg, meta) => console.error("[proxy]", lv, msg, JSON.stringify(meta ?? "")),
    onUsage: (sid, u) => console.error("[usage]", sid, JSON.stringify(u)),
  },
});
p.register("sess-prod", {
  baseUrl: ${JSON.stringify(BASE_URL)},
  apiKey: ${JSON.stringify(KEY)},
});
console.error("[proxy] ready on", p.url);
`;

const proxyPath = path.join(home, "proxy.mts");
fs.writeFileSync(proxyPath, proxyEntry);

const repoRoot = "D:/codespace/project-rakko";
const tsxBin = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const proxy = spawn(
  tsxBin,
  [proxyPath],
  { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], shell: true, env: { ...process.env, RAKKO_API_KEY: "" } }
);
let proxyLog = "";
proxy.stderr.on("data", (d) => {
  proxyLog += d.toString();
  for (const line of d.toString().split("\n")) {
    if (line.trim()) console.log("[pxy]", line.trim().slice(0, 200));
  }
});

// models.json 指向产品 proxy
fs.writeFileSync(
  path.join(home, "models.json"),
  JSON.stringify(
    {
      providers: {
        mine: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${PROXY_PORT}/v1`,
          apiKey: "$RAKKO_PI_API_KEY",
          headers: { "x-rakko-session-id": "sess-prod" },
          models: [
            {
              id: MODEL, name: MODEL, contextWindow: 128000, maxOutput: 8192,
              supportsTools: true,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    null,
    2
  )
);

const { RAKKO_API_KEY: _omit, ...cleanEnv } = process.env;
const env = {
  ...cleanEnv,
  PI_CODING_AGENT_DIR: home,
  RAKKO_PI_API_KEY: "proxy-managed-sess-pro",
  RAKKO_PI_SESSION_ID: "sess-prod",
  NO_PROXY: "127.0.0.1,localhost",
  PI_OFFLINE: "1",
};

console.log("=== 前置检查 ===");
console.log("env 里含真 key:", JSON.stringify(env).includes(KEY));
console.log("env 里的 key 值:", env.RAKKO_PI_API_KEY);
console.log("上游:", BASE_URL);
console.log("模型:", MODEL);

setTimeout(() => {
  console.log("\n=== pi → 产品 proxy → 真实上游 ===");
  const r = spawnSync(
    NODE,
    [
      PI, "--print", "--no-session",
      "--no-extensions", "--no-skills", "--no-prompt-templates",
      "--no-themes", "--no-mcp", "--no-context-files", "--no-approve",
      "--tools", "ls,read",
      "--provider", "mine", "--model", MODEL,
      "读 notes.md，用一句话告诉我里面写了什么",
    ],
    { env, cwd: ws, encoding: "utf8", timeout: 120000 }
  );

  console.log("exit:", r.status);
  console.log("--- 回答");
  console.log((r.stdout || "(空)").slice(0, 500));
  if (r.stderr && r.stderr.trim()) console.log("--- stderr:", r.stderr.slice(0, 400));

  proxy.kill();
  setTimeout(() => process.exit(0), 500);
}, 4000);
