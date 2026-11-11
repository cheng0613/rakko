#!/usr/bin/env node
/**
 * 验证裁剪后的 pi 运行时可用。
 *
 * 不是「能 --version」就算过 —— 要跑完整闭环：
 *   启动 → 握手 → prompt → 流式响应 → 工具调用 → 结果回传
 *
 * 用假上游，不花钱、不依赖网络。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const PI_DIR = path.join(repoRoot, "resources", "pi");
const CLI = path.join(PI_DIR, "bundle", "cli.js");
const NODE = process.execPath;
const PORT = 54300 + Math.floor(Math.random() * 100);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "rakko-pi-verify-"));
const agentHome = path.join(home, "agent-home");
const ws = path.join(home, "ws");
fs.mkdirSync(agentHome, { recursive: true });
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(ws, "hello.txt"), "验证文件内容\n");

let ok = 0;
let fail = 0;
function check(label, pass, detail = "") {
  if (pass) {
    ok++;
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 假上游：第一轮要工具调用，第二轮给文本 */
let turn = 0;
const upstream = http.createServer((req, res) => {
  if (req.url.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "probe" }] }));
    return;
  }
  if (!/chat\/completions$/.test(req.url)) {
    res.writeHead(200);
    res.end("{}");
    return;
  }
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    turn++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "x", object: "chat.completion.chunk", created: 1, model: "probe" };
    const emit = (delta, finish, usage) => {
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`,
      );
    };
    if (turn === 1) {
      emit(
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path: "hello.txt" }) },
            },
          ],
        },
        null,
      );
      emit({}, "tool_calls", { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
    } else {
      for (const t of ["读到", "了文件"]) emit({ content: t }, null);
      emit({}, "stop", { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

async function main() {
  console.log("=== 检查产物 ===");
  check("bundle/cli.js 存在", fs.existsSync(CLI));
  const manifestPath = path.join(PI_DIR, "PI-RUNTIME.json");
  check("PI-RUNTIME.json 存在", fs.existsSync(manifestPath));
  if (fs.existsSync(manifestPath)) {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    check(`版本是 1.4.0`, m.version === "1.4.0", `实际 ${m.version}`);
    check(`体积 <= 100MB`, m.outputSizeMB <= 100, `${m.outputSizeMB}MB`);
    console.log(`    裁剪项: ${m.pruned.map((p) => p.dir).join(", ") || "(无)"}`);
  }
  const needDir = path.join(PI_DIR, "bundle", "chunks", "dist", "modes");
  check("bundle/chunks/dist/modes 存在（资源路径依赖）", fs.existsSync(needDir));

  console.log("\n=== --version ===");
  const ver = spawnSync(NODE, [CLI, "--version"], { encoding: "utf8", timeout: 30000 });
  check("能报版本", ver.status === 0, (ver.stdout || ver.stderr || "").trim().slice(0, 60));

  await new Promise((r) => upstream.listen(PORT, "127.0.0.1", r));

  fs.writeFileSync(
    path.join(agentHome, "models.json"),
    JSON.stringify({
      providers: {
        probe: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${PORT}/v1`,
          apiKey: "$RAKKO_PI_API_KEY",
          models: [
            {
              id: "probe",
              name: "Probe",
              contextWindow: 128000,
              maxOutput: 4096,
              supportsTools: true,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );

  console.log("\n=== RPC 会话 + 工具调用闭环 ===");
  const p = spawn(
    NODE,
    [
      CLI,
      "--mode", "rpc",
      "--no-session",
      "--no-extensions", "--no-skills", "--no-prompt-templates",
      "--no-themes", "--no-mcp", "--no-context-files", "--no-approve",
      "--tools", "read",
      "--provider", "probe", "--model", "probe",
    ],
    {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentHome, RAKKO_PI_API_KEY: "k" },
      cwd: ws,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let gotState = false;
  let gotText = "";
  let gotToolEnd = false;
  let gotTurnEnd = false;
  let stderr = "";

  let buf = "";
  p.stdout.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (j.type === "response" && j.command === "get_state" && j.success) gotState = true;
      if (j.type === "message_update" && j.assistantMessageEvent?.type === "text_delta") {
        gotText += j.assistantMessageEvent.delta;
      }
      if (j.type === "tool_execution_end") gotToolEnd = !j.isError;
      if (j.type === "turn_end") gotTurnEnd = true;
    }
  });
  p.stderr.on("data", (d) => (stderr += d.toString()));

  p.stdin.write(JSON.stringify({ id: "r1", type: "get_state" }) + "\n");
  await new Promise((r) => setTimeout(r, 1500));
  p.stdin.write(JSON.stringify({ id: "p1", type: "prompt", message: "读 hello.txt" }) + "\n");
  await new Promise((r) => setTimeout(r, 8000));

  check("get_state 握手成功", gotState);
  check("工具执行成功（read 跑了）", gotToolEnd);
  check("收到流式文本", gotText.length > 0, JSON.stringify(gotText.slice(0, 20)));
  check("轮次结束", gotTurnEnd);
  if (stderr.trim()) {
    console.log(`  [pi stderr] ${stderr.trim().slice(0, 200)}`);
  }

  p.kill();
  upstream.close();
  fs.rmSync(home, { recursive: true, force: true });

  console.log(`\n=== ${fail === 0 ? "全部通过" : `${fail} 项失败`}（${ok} 通过 / ${fail} 失败）===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
