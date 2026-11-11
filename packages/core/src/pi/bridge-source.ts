/**
 * rakko-bridge：写进 pi 的 agentHome/extensions/ 的权限门扩展。
 *
 * 这段代码**跑在 pi 子进程里**，不能 import 宿主任何模块。
 * 只依赖 pi 的 ExtensionAPI、node:fs、node:path。
 *
 * 职责只有一个：tool_call 拦截 + 审批。
 *
 * 三条硬约束：
 *   1. 权限档从文件**每次现读** —— 主进程改文件即热切换，不用重启 pi
 *   2. 读不到 / 解析失败 → 一律当 ask（fail-closed，不变量 4）
 *   3. 控制面写入（改 agentHome 里的 models.json / 权限档）**即使完全访问也要问**
 *
 * RPC 模式下的协议（实测 pi 1.4.0）：
 *   ctx.ui.input(title, payload) → extension_ui_request
 *     { type:"extension_ui_request", id, method:"input", title, placeholder: payload }
 *   宿主回：{ type:"extension_ui_response", id, value: "<决定>" }
 *
 * 注意 payload 落在 placeholder 字段，不是 body —— 以实测为准。
 */

/** 扩展文件名。主进程按这个名字写盘。 */
export const RAKKO_BRIDGE_FILENAME = "rakko-bridge.ts";

/** 审批请求的 title，宿主用它识别这是权限请求而不是普通输入框 */
export const RAKKO_PERMISSION_TITLE = "rakko:permission";

/** 三个决定的字面量 */
export const RAKKO_ALLOW_ONCE = "rakko:allow-once";
export const RAKKO_ALLOW_TYPE = "rakko:allow-type";
export const RAKKO_DENY = "rakko:deny";

/**
 * 生成扩展源码。
 *
 * 用模板而不是直接 import 这个常量，是因为 pi 子进程有自己的模块解析规则，
 * 宿主代码不能被它 import。把运行时需要的一切都塞进这段字符串里。
 */
export function buildBridgeSource(options: {
  /** 权限档文件的绝对路径 */
  permissionFile: string;
  /** agentHome 绝对路径，用于识别控制面写入 */
  agentHome: string;
}): string {
  // 路径要转义成 JS 字符串字面量，Windows 反斜杠不能直接进模板
  const permFileLiteral = JSON.stringify(options.permissionFile);
  const agentHomeLiteral = JSON.stringify(options.agentHome);
  const titleLiteral = JSON.stringify(RAKKO_PERMISSION_TITLE);
  const allowOnceLiteral = JSON.stringify(RAKKO_ALLOW_ONCE);
  const allowTypeLiteral = JSON.stringify(RAKKO_ALLOW_TYPE);
  const denyLiteral = JSON.stringify(RAKKO_DENY);

  return `/**
 * Rakko 权限门。由主进程生成并覆写，请勿手工编辑。
 *
 * 跑在 pi 子进程内，只依赖 pi 的 ExtensionAPI 与 node 内置模块。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const PERMISSION_FILE = ${permFileLiteral};
const AGENT_HOME = ${agentHomeLiteral};
const TITLE = ${titleLiteral};
const ALLOW_ONCE = ${allowOnceLiteral};
const ALLOW_TYPE = ${allowTypeLiteral};

/** 只读工具：三类模式都直接放行 */
const READONLY = new Set(["read", "ls", "grep", "find", "glob"]);

/** 会改文件的工具 */
const WRITE = new Set(["write", "edit", "apply_patch", "patch"]);

/** 会执行命令的工具 */
const SHELL = new Set(["bash", "shell", "powershell", "exec", "run"]);

/** 询问用户时不打扰的工具（纯元信息查询） */
const SILENT = new Set(["ask_user_question"]);

/**
 * 读当前权限档。**每次 tool_call 都重新读** —— 热切换靠这个。
 * 任何异常一律回落 ask，绝不宽松回落。
 */
function readMode() {
  if (!PERMISSION_FILE) return "ask";
  try {
    const parsed = JSON.parse(readFileSync(PERMISSION_FILE, "utf8"));
    const m = parsed && parsed.mode;
    if (m === "bypassPermissions") return "bypassPermissions";
    if (m === "auto") return "auto";
    return "ask";
  } catch {
    return "ask";
  }
}

/**
 * 判断一次写入是否落在 agentHome 内（控制面）。
 *
 * agentHome 里有 models.json 与权限档本身。模型若能改写它们，
 * 就能把后续请求劫持到别的 endpoint，或把自己的权限调到完全访问。
 */
function isControlPlaneWrite(toolName, input) {
  if (!WRITE.has(toolName)) return false;
  const target = input && typeof input.path === "string" ? input.path : "";
  if (!target || !AGENT_HOME) return false;
  try {
    const resolved = path.resolve(target);
    const rel = path.relative(AGENT_HOME, resolved);
    return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel));
  } catch {
    // 解析失败时保守：当作控制面，宁可多问一次
    return true;
  }
}

function riskOf(toolName) {
  if (READONLY.has(toolName)) return "low";
  if (WRITE.has(toolName) || SHELL.has(toolName)) return "high";
  return "high";
}

export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    const toolName = String((event && event.toolName) || "");
    const input = (event && event.input) || {};
    const mode = readMode();

    // 元信息类工具不打扰
    if (SILENT.has(toolName)) return;

    const controlPlane = isControlPlaneWrite(toolName, input);

    // 完全访问：控制面以外全部放行
    if (mode === "bypassPermissions" && !controlPlane) return;

    // 只读工具放行（控制面写入不会是只读工具，这里已排除）
    if (READONLY.has(toolName) && !controlPlane) return;

    // auto 档：P0 与 ask 相同（写与命令都问）。
    // 真正的自动分类需要独立的分类器，属于 P1。
    // 这里显式写出来，避免以后误以为 auto 已经生效。

    // 没有 UI（比如无人值守）时 fail-closed：不静默放行
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: "Rakko：需要审批但没有可用的界面，已阻止。",
      };
    }

    let decision;
    try {
      decision = await ctx.ui.input(TITLE, JSON.stringify({
        toolName,
        input,
        risk: riskOf(toolName),
        controlPlane,
        mode,
      }));
    } catch (err) {
      // 询问失败同样 fail-closed
      return {
        block: true,
        reason: "Rakko：审批请求失败，已阻止。（" + String(err && err.message || err) + "）",
      };
    }

    if (decision === ALLOW_ONCE) return;
    if (decision === ALLOW_TYPE) return; // P0：与 allow-once 同义，P1 再做类型级记忆

    return {
      block: true,
      reason: controlPlane
        ? "Rakko：用户拒绝了对应用配置目录的写入。"
        : "Rakko：用户拒绝了这次工具调用。",
    };
  });
}
`;
}
