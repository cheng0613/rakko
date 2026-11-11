/**
 * PiHost：spawn `pi --mode rpc`，走 stdin/stdout 的 JSONL。
 *
 * 协议（实测 pi 1.4.0）：
 *   发命令：{"id":"r1","type":"prompt","message":"..."}\n
 *   收回执：{"id":"r1","type":"response","command":"prompt","success":true,"data":{...}}
 *   收事件：{"type":"agent_start"} / {"type":"message_update",...} ...
 *
 * 设计要点：
 * - 不缓冲 stdout（逐行解析）
 * - 命令有超时，避免 UI 永久卡住
 * - 进程意外退出时，把在途命令全部 reject，不留悬空 Promise
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { AgentEvent, PermissionRequest, ToolRisk } from "@rakko/shared";
import { PiTranslator, classifyToolRisk, type PiRawEvent } from "./translator.js";
import { RAKKO_DENY, RAKKO_PERMISSION_TITLE } from "./bridge-source.js";

export interface PiHostOptions {
  /**
   * node 可执行文件路径。**必填**，不要用 process.execPath：
   * 在 Electron 里它是 electron.exe，跑 js 会直接失败。
   */
  nodePath: string;
  /** pi 的 cli.js 绝对路径 */
  piEntry: string;
  /** 会话 id */
  sessionId: string;
  /** pi 配置目录 */
  agentHome: string;
  /** 工作目录 */
  cwd: string;
  /** spawn env（必须是确定性构造的，见 env.ts） */
  env: Record<string, string>;
  /** 额外命令行参数，如 --tools / --append-system-prompt */
  extraArgs?: string[];
  /** 事件回调 */
  onEvent: (event: AgentEvent) => void;
  /** 进程退出回调 */
  onExit?: (code: number | null, signal: string | null) => void;
  /**
   * 收到权限请求。宿主处理后调 respondUi(id, decision) 回复。
   * 不提供时一律拒绝（fail-closed）。
   */
  onPermissionRequest?: (request: PermissionRequest) => void;
  /** 命令默认超时（毫秒） */
  commandTimeoutMs?: number;
  /** 日志 */
  log?: (level: "info" | "warn" | "error", msg: string, meta?: unknown) => void;
}

interface PendingCommand {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  command: string;
}

export class PiHostError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "PiHostError";
  }
}

const DEFAULT_TIMEOUT = 30_000;

export class PiHost {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly translator: PiTranslator;
  private seq = 0;
  private exited = false;
  private disposed = false;

  constructor(private readonly options: PiHostOptions) {
    this.translator = new PiTranslator(options.onEvent);
  }

  get isRunning(): boolean {
    return this.proc !== null && !this.exited && !this.disposed;
  }

  /** 启动子进程。重复调用无副作用。 */
  start(): void {
    if (this.proc) throw new PiHostError("PiHost 已经启动", "ALREADY_STARTED");
    if (this.disposed) throw new PiHostError("PiHost 已销毁", "DISPOSED");

    const args = [
      this.options.piEntry,
      "--mode",
      "rpc",
      "--no-approve",
      ...(this.options.extraArgs ?? []),
    ];

    this.log("info", "spawn pi", {
      sessionId: this.options.sessionId,
      entry: this.options.piEntry,
      args,
    });

    const proc = spawn(this.options.nodePath, args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.proc = proc;
    this.exited = false;

    this.reader = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    this.reader.on("line", (line) => this.handleLine(line));

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.log("warn", "pi stderr", { text: text.slice(0, 2000) });
    });

    proc.on("error", (err) => {
      this.log("error", "pi 进程错误", { message: err.message });
      this.failAllPending(new PiHostError(`pi 进程错误：${err.message}`, "PROCESS_ERROR"));
    });

    proc.on("exit", (code, signal) => {
      this.exited = true;
      this.log("info", "pi 进程退出", { code, signal });
      this.failAllPending(
        new PiHostError(`pi 进程已退出（code=${String(code)}, signal=${String(signal)}）`, "PROCESS_EXITED"),
      );
      this.translator.abortTurn();
      this.options.onExit?.(code, signal);
    });
  }

  /**
   * 发一条 prompt。返回 pi 的 immediate 回执（disposition），
   * 真正的对话内容走事件流。
   */
  async prompt(message: string): Promise<unknown> {
    return this.send({ type: "prompt", message });
  }

  /** 中止当前轮次 */
  async abort(): Promise<unknown> {
    const result = await this.send({ type: "abort" });
    // 不等 pi 的 agent_settled：用户点了停止，UI 应该立刻收口
    this.translator.abortTurn();
    return result;
  }

  async getState(): Promise<unknown> {
    return this.send({ type: "get_state" });
  }

  async getMessages(): Promise<unknown> {
    return this.send({ type: "get_messages" });
  }

  /** 发任意 RPC 命令 */
  async send(command: Record<string, unknown>): Promise<unknown> {
    if (!this.proc || this.exited) {
      throw new PiHostError("pi 进程未运行", "NOT_RUNNING");
    }
    const type = String(command["type"] ?? "unknown");

    this.seq += 1;
    const id = `r${this.seq}`;
    const timeoutMs = this.options.commandTimeoutMs ?? DEFAULT_TIMEOUT;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiHostError(`命令超时：${type}（${timeoutMs}ms）`, "COMMAND_TIMEOUT"));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, command: type });

      try {
        this.proc!.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new PiHostError(
            `写入 pi stdin 失败：${(err as Error).message}`,
            "STDIN_WRITE_FAILED",
          ),
        );
      }
    });
  }

  /** 优雅停止 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    this.reader?.close();
    this.reader = null;
    this.failAllPending(new PiHostError("PiHost 已销毁", "DISPOSED"));

    const proc = this.proc;
    this.proc = null;
    if (!proc || this.exited) return;

    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      proc.once("exit", done);

      // 先温和，给它收尾的机会
      proc.kill("SIGTERM");

      const forceTimer = setTimeout(() => {
        if (!this.exited) {
          this.log("warn", "pi 未在 3 秒内退出，强杀");
          proc.kill("SIGKILL");
        }
      }, 3000);

      // 避免定时器挂住进程
      forceTimer.unref?.();
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      this.log("warn", "pi 输出了非 JSON 行", { line: trimmed.slice(0, 500) });
      return;
    }

    if (typeof raw !== "object" || raw === null) return;
    const obj = raw as Record<string, unknown>;

    // 扩展 UI 请求（权限审批走这里）
    if (obj["type"] === "extension_ui_request") {
      this.handleExtensionUiRequest(obj);
      return;
    }

    // 命令回执
    if (obj["type"] === "response") {
      const id = typeof obj["id"] === "string" ? obj["id"] : null;
      if (!id) return;
      const pendingCmd = this.pending.get(id);
      if (!pendingCmd) {
        this.log("warn", "收到无法匹配的回执", { id });
        return;
      }
      clearTimeout(pendingCmd.timer);
      this.pending.delete(id);

      if (obj["success"] === false) {
        const detail = obj["error"] ?? obj["message"] ?? "未知错误";
        pendingCmd.reject(
          new PiHostError(
            `pi 命令失败：${pendingCmd.command} → ${typeof detail === "string" ? detail : JSON.stringify(detail)}`,
            "COMMAND_FAILED",
          ),
        );
      } else {
        pendingCmd.resolve(obj["data"] ?? null);
      }
      return;
    }

    // 其余都是事件，交给 translator
    try {
      this.translator.handle(obj as PiRawEvent);
    } catch (err) {
      this.log("error", "translator 处理事件失败", {
        type: obj["type"],
        message: (err as Error).message,
      });
    }
  }

  /**
   * 处理扩展 UI 请求。
   *
   * 实测 pi 1.4.0 的 input 请求形状：
   *   { type:"extension_ui_request", id, method:"input", title, placeholder }
   * payload 在 placeholder 字段里（不是 body）。
   *
   * 只有 title 是 RAKKO_PERMISSION_TITLE 的才是我们的权限请求；
   * 其余（比如别的扩展的输入框）直接回空值拒绕，避免 pi 卡住等回应。
   */
  private handleExtensionUiRequest(msg: Record<string, unknown>): void {
    const id = typeof msg["id"] === "string" ? msg["id"] : null;
    if (!id) {
      this.log("warn", "extension_ui_request 缺少 id", { keys: Object.keys(msg) });
      return;
    }

    const title = typeof msg["title"] === "string" ? msg["title"] : "";
    const isPermission = title === RAKKO_PERMISSION_TITLE;

    if (!isPermission) {
      // 不是我们的请求：回空字符串，让 pi 继续（总比卡住好）
      this.log("warn", "未知的扩展 UI 请求，已回空", { title: title.slice(0, 80) });
      this.respondUi(id, "");
      return;
    }

    // payload 在 placeholder（实测），兼容 body 以防版本差异
    const rawPayload = (msg["placeholder"] ?? msg["body"]) as unknown;
    let payload: { toolName?: unknown; input?: unknown; risk?: unknown; controlPlane?: unknown } = {};
    if (typeof rawPayload === "string") {
      try {
        payload = JSON.parse(rawPayload) as typeof payload;
      } catch {
        this.log("warn", "权限请求 payload 不是合法 JSON");
      }
    } else if (rawPayload && typeof rawPayload === "object") {
      payload = rawPayload as typeof payload;
    }

    const toolName = typeof payload.toolName === "string" ? payload.toolName : "unknown";
    const request: PermissionRequest = {
      callId: id,
      toolName,
      input: payload.input ?? null,
      risk: normalizeRisk(payload.risk ?? classifyToolRisk(toolName)),
      summary: summarizePermission(toolName, payload.input),
      controlPlane: payload.controlPlane === true,
    };

    if (!this.options.onPermissionRequest) {
      // 没人处理 → 保守拒绝，绝不静默放行
      this.log("warn", "收到权限请求但没有处理器，默认拒绝", { toolName });
      this.respondUi(id, RAKKO_DENY);
      return;
    }

    this.options.onPermissionRequest(request);
  }

  /** 回答一个扩展 UI 请求 */
  respondUi(id: string, value: string): void {
    if (!this.proc || this.exited) return;
    try {
      this.proc.stdin.write(
        `${JSON.stringify({ type: "extension_ui_response", id, value })}\n`,
      );
    } catch (err) {
      this.log("error", "回复扩展 UI 请求失败", { message: (err as Error).message });
    }
  }

  private failAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  private log(level: "info" | "warn" | "error", msg: string, meta?: unknown): void {
    this.options.log?.(level, msg, meta);
  }
}

function normalizeRisk(value: unknown): ToolRisk {
  return value === "low" || value === "medium" || value === "high" ? value : "high";
}

/**
 * 生成审批卡的展示摘要。
 *
 * 主进程生成而不是渲染层生成：渲染层拿到的应该是「可以显示什么」，
 * 而不是「原始 input 长什么样」—— 后者可能很大，也可能含敏感路径。
 */
function summarizePermission(toolName: string, input: unknown): string {
  if (input === null || input === undefined) return toolName;

  const obj = typeof input === "object" ? (input as Record<string, unknown>) : null;
  if (!obj) return `${toolName}: ${String(input).slice(0, 200)}`;

  // bash：显示命令本身
  if (typeof obj["command"] === "string") {
    const cmd = obj["command"];
    return cmd.length > 300 ? `${cmd.slice(0, 300)}…` : cmd;
  }

  // 文件类工具：显示路径
  if (typeof obj["path"] === "string") {
    return String(obj["path"]);
  }

  try {
    const s = JSON.stringify(input);
    return s.length > 300 ? `${s.slice(0, 300)}…` : s;
  } catch {
    return toolName;
  }
}
