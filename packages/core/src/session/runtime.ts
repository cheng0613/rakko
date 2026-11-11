/**
 * 会话运行时：把 PiHost、models.json、append prompt 串成一个可用会话。
 *
 * 这一层不 import electron —— 平台能力（配置目录、日志）由调用方注入。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentEvent, ProviderConfig } from "@rakko/shared";
import { writeModelsJson, writeModelsJsonDirect } from "../pi/models-json.js";
import { assertAppendPromptUsable, writeAppendPrompt } from "../pi/append-prompt.js";
import { buildPiEnv } from "../pi/env.js";
import { PiHost } from "../pi/host.js";
import { resolveNodeBinary, resolvePiEntry } from "../pi/resolve-pi.js";

export interface StartSessionOptions {
  sessionId: string;
  /** 该会话的配置根目录（绝对路径，由调用方给出） */
  dataDir: string;
  /** 工作目录 */
  cwd: string;
  /** proxy 端口（models.json 与 env 都指向它）。P0 无 proxy 时为 0 */
  proxyPort: number;
  providers: ProviderConfig[];
  /**
   * 真实上游 key。
   * 它只进 spawn env（供 pi 直连上游），或交给 proxy 去换，
   * **不写进 models.json**，也不下发到渲染进程。
   */
  apiKey?: string;
  /** 系统提示的追加段落，按顺序拼接 */
  promptSections: string[];
  /** 是否开启工具。默认 false（P0 先跑通纯对话） */
  tools?: string[] | "all";
  /** 事件回调 */
  onEvent: (event: AgentEvent) => void;
  log?: (level: "info" | "warn" | "error", msg: string, meta?: unknown) => void;
}

export interface SessionRuntime {
  sessionId: string;
  /** 发一条消息 */
  send(text: string): Promise<void>;
  /** 中止当前轮 */
  abort(): Promise<void>;
  /** 关闭 */
  dispose(): Promise<void>;
  /** 是否在运行 */
  readonly running: boolean;
}

export class SessionStartError extends Error {
  constructor(
    message: string,
    readonly step: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "SessionStartError";
  }
}
/**
 * 启动一个会话。
 *
 * 顺序很重要：
 *   1. 建目录
 *   2. 写 append prompt 并**回读校验**（不变量 8）
 *   3. 写 models.json（不变量 9）
 *   4. 构造确定性 env（不变量 2）
 *   5. spawn
 *
 * 任一步失败都抛错，不生成半可用的会话。
 */
export async function startSession(options: StartSessionOptions): Promise<SessionRuntime> {
  const { sessionId, dataDir, cwd, proxyPort, providers, promptSections } = options;
  const log = options.log ?? (() => {});

  // P0 阶段没有 CompatProxy：models.json 直接写真实上游，
  // key 通过 env 交给 pi。接入 proxy 后，baseUrl 改成 loopback，
  // 这里改为把 apiKey 交给 proxy，models.json 里只留占位。
  const useProxy = proxyPort > 0;
  if (!useProxy && !options.apiKey) {
    throw new SessionStartError(
      "未提供 apiKey。P0 阶段（无 proxy）需要把 key 通过 env 交给 pi。",
      "no-api-key",
    );
  }

  const agentHome = path.join(dataDir, "agent-home");
  try {
    await fs.mkdir(agentHome, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
  } catch (e) {
    throw new SessionStartError(`创建目录失败：${(e as Error).message}`, "mkdir", e);
  }

  // ── 1. append prompt ──
  let promptPath: string | undefined;
  let promptBytes: number | undefined;
  if (promptSections.length > 0) {
    try {
      const written = await writeAppendPrompt(agentHome, promptSections);
      await assertAppendPromptUsable(written.absolutePath, written.bytes);
      promptPath = written.absolutePath;
      promptBytes = written.bytes;
      log("info", "append prompt 就绪", { bytes: promptBytes, hash: written.hash });
    } catch (e) {
      throw new SessionStartError(`写入系统提示失败：${(e as Error).message}`, "append-prompt", e);
    }
  }

  // ── 2. models.json ──
  try {
    // 有 proxy：baseUrl 指向 loopback，key 写占位（真 key 在 proxy 内存）。
    // 无 proxy（P0）：baseUrl 直接写 provider 自己的上游，key 走 env。
    const proxyBase = useProxy
      ? `http://127.0.0.1:${proxyPort}/v1`
      : null;

    if (proxyBase) {
      await writeModelsJson(agentHome, { proxyBaseUrl: proxyBase, providers });
    } else {
      await writeModelsJsonDirect(agentHome, providers);
    }
    log("info", "models.json 就绪", {
      providers: providers.map((p) => p.id),
      mode: proxyBase ? "proxy" : "direct",
    });
  } catch (e) {
    throw new SessionStartError(`写入 models.json 失败：${(e as Error).message}`, "models-json", e);
  }

  // ── 3. pi 入口与 node 二进制 ──
  let piEntry: string;
  let nodePath: string;
  try {
    const resolved = await resolvePiEntry();
    piEntry = resolved.entry;
    log("info", "pi 入口", { entry: piEntry, version: resolved.version, source: resolved.source });

    const node = await resolveNodeBinary();
    nodePath = node.path;
    log("info", "node 二进制", { path: nodePath, version: node.version, source: node.source });
  } catch (e) {
    throw new SessionStartError(`找不到 pi 或 node：${(e as Error).message}`, "resolve-pi", e);
  }

  // ── 4. env（确定性） ──
  const env = buildPiEnv({
    sessionId,
    agentHome,
    proxyPort,
    // 无 proxy 时，pi 需要真 key 才能直连上游
    ...(useProxy ? {} : { extra: { RAKKO_PI_API_KEY: options.apiKey! } }),
  });

  // ── 5. 参数 ──
  const extraArgs: string[] = [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-mcp",
    "--no-context-files",
  ];

  if (options.tools === "all") {
    // 不传 --no-tools，用 pi 的默认工具集
  } else if (Array.isArray(options.tools) && options.tools.length > 0) {
    extraArgs.push("--tools", options.tools.join(","));
  } else {
    extraArgs.push("--no-tools");
  }

  if (promptPath) {
    extraArgs.push("--append-system-prompt", promptPath);
  }

  // 模型：用第一个 provider 的第一个模型
  const firstProvider = providers[0];
  const firstModel = firstProvider?.models[0];
  if (!firstProvider || !firstModel) {
    throw new SessionStartError("没有可用的 provider / model", "no-model");
  }
  extraArgs.push("--provider", firstProvider.id, "--model", firstModel.id);

  // ── 6. spawn ──
  const host = new PiHost({
    nodePath,
    piEntry,
    sessionId,
    agentHome,
    cwd,
    env,
    extraArgs,
    onEvent: options.onEvent,
    onExit: (code: number | null, signal: string | null) => log("info", "pi 退出", { code, signal }),
    log,
  });

  try {
    host.start();
    await host.getState();
  } catch (e) {
    await host.dispose().catch(() => {});
    throw new SessionStartError(`启动 pi 失败：${(e as Error).message}`, "spawn", e);
  }

  return {
    sessionId,
    get running() {
      return host.isRunning;
    },
    async send(text: string) {
      await host.prompt(text);
    },
    async abort() {
      await host.abort();
    },
    async dispose() {
      await host.dispose();
    },
  };
}
