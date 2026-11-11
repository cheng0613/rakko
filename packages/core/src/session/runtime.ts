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
import {
  RAKKO_ALLOW_ONCE,
  RAKKO_ALLOW_TYPE,
  RAKKO_BRIDGE_FILENAME,
  RAKKO_DENY,
  buildBridgeSource,
} from "../pi/bridge-source.js";
import { PERMISSION_FILENAME, writePermissionMode } from "./permission-store.js";

export interface StartSessionOptions {
  sessionId: string;
  /** 该会话的配置根目录（绝对路径，由调用方给出） */
  dataDir: string;
  /** 工作目录 */
  cwd: string;
  /**
   * CompatProxy。有它时：models.json 指向 loopback，key 交给 proxy，
   * pi 的 spawn env 里只有占位值。
   * 没它时（P0 早期形态）：直连上游，key 进 env。
   *
   * **生产路径必须传它** —— 不传就意味着 key 进了子进程 env，
   * 违背 AGENTS.md 不变量 13。
   */
  proxy?: {
    port: number;
    register: (sessionId: string, target: { baseUrl: string; apiKey: string }) => void;
  };
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
  /** 权限请求回调。不提供时一律拒绝（fail-closed） */
  onPermissionRequest?: (request: import("@rakko/shared").PermissionRequest) => void;
  /** 初始权限档，默认 ask */
  initialPermissionMode?: import("@rakko/shared").PermissionMode;
  log?: (level: "info" | "warn" | "error", msg: string, meta?: unknown) => void;
}

export interface SessionRuntime {
  sessionId: string;
  /** 发一条消息 */
  send(text: string): Promise<void>;
  /** 中止当前轮 */
  abort(): Promise<void>;
  /** 切换权限档（热切换，不用重启 pi） */
  setPermissionMode(mode: import("@rakko/shared").PermissionMode): Promise<void>;
  /** 回答一个权限请求 */
  respondPermission(callId: string, decision: import("@rakko/shared").PermissionDecision): Promise<void>;
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
  const { sessionId, dataDir, cwd, providers, promptSections } = options;
  const log = options.log ?? (() => {});

  const useProxy = options.proxy !== undefined;
  if (!useProxy && !options.apiKey) {
    throw new SessionStartError(
      "未提供 apiKey。无 proxy 时需要把 key 通过 env 交给 pi。",
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
    const proxyBase = useProxy ? `http://127.0.0.1:${options.proxy!.port}/v1` : null;

    if (proxyBase) {
      await writeModelsJson(agentHome, {
        proxyBaseUrl: proxyBase,
        providers,
        sessionId,
      });
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

  // ── 2.5 把真 key 交给 proxy（不写进 models.json，不进 env）──
  if (useProxy) {
    const primary = providers[0];
    if (!primary) {
      throw new SessionStartError("没有可用的 provider", "no-provider");
    }
    if (!options.apiKey) {
      throw new SessionStartError("proxy 模式必须提供 apiKey", "no-api-key");
    }
    options.proxy!.register(sessionId, {
      baseUrl: primary.baseUrl,
      apiKey: options.apiKey,
    });
    log("info", "真 key 已交给 proxy", { sessionId, upstream: primary.baseUrl });
  }

  // ── 2.6 写权限门扩展与权限档 ──
  const runtimeDir = path.join(agentHome, "runtime");
  const extensionsDir = path.join(agentHome, "extensions");
  const permissionFile = path.join(runtimeDir, PERMISSION_FILENAME);
  try {
    await fs.mkdir(extensionsDir, { recursive: true });
    const source = buildBridgeSource({ permissionFile, agentHome });
    const bridgePath = path.join(extensionsDir, RAKKO_BRIDGE_FILENAME);
    await fs.writeFile(bridgePath, source, "utf8");

    // 回读校验：扩展文件写坏了，pi 会启动失败且报错不直观
    const readBack = await fs.readFile(bridgePath, "utf8");
    if (readBack !== source) {
      throw new Error("权限门扩展写入后回读不一致");
    }

    await writePermissionMode(runtimeDir, options.initialPermissionMode ?? "ask");
    log("info", "权限门就绪", {
      bridge: bridgePath,
      permissionFile,
      mode: options.initialPermissionMode ?? "ask",
    });
  } catch (e) {
    throw new SessionStartError(`写入权限门失败：${(e as Error).message}`, "permission-bridge", e);
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
    proxyPort: useProxy ? options.proxy!.port : 0,
    // 权限档文件路径：bridge 靠它热切换
    extra: {
      RAKKO_PI_PERMISSION_FILE: permissionFile,
      ...(useProxy ? {} : { RAKKO_PI_API_KEY: options.apiKey! }),
    },
  });

  // ── 5. 参数 ──
  const extraArgs: string[] = [
    // 不传 --no-extensions：要让刚写的权限门扩展加载
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-mcp",
    "--no-context-files",
    // 显式加载我们的扩展，不依赖目录扫描
    "--extension",
    path.join(extensionsDir, RAKKO_BRIDGE_FILENAME),
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
    onPermissionRequest: options.onPermissionRequest,
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
    async setPermissionMode(mode) {
      // 写文件即热切换：bridge 每次 tool_call 都会重读
      await writePermissionMode(runtimeDir, mode);
      log("info", "权限档已切换", { mode });
    },
    async respondPermission(callId, decision) {
      const value =
        decision === "allow-once"
          ? RAKKO_ALLOW_ONCE
          : decision === "allow-type"
            ? RAKKO_ALLOW_TYPE
            : RAKKO_DENY;
      host.respondUi(callId, value);
    },
    async dispose() {
      await host.dispose();
    },
  };
}
