import { describe, expect, it } from "vitest";
import {
  RAKKO_ALLOW_ONCE,
  RAKKO_ALLOW_TYPE,
  RAKKO_BRIDGE_FILENAME,
  RAKKO_DENY,
  RAKKO_PERMISSION_TITLE,
  buildBridgeSource,
} from "../bridge-source.js";

const OPTS = {
  permissionFile: "/tmp/agent-home/runtime/perm.json",
  agentHome: "/tmp/agent-home",
};

/**
 * 检查一段源码语法是否合法。
 * 去掉 import/export 后交给 Function 构造器解析 —— 它不执行，只做语法检查。
 */
function parsesAsScript(source: string): boolean {
  const stripped = source
    .replace(/^import .*$/gm, "")
    .replace(/^export default /gm, "const __ext = ")
    .replace(/^export /gm, "");
  try {
    new Function(stripped);
    return true;
  } catch {
    return false;
  }
}

describe("生成的扩展源码", () => {
  const src = buildBridgeSource(OPTS);

  it("是可被解析的 JS（语法正确）", () => {
    expect(parsesAsScript(src)).toBe(true);
  });

  it("包含权限档文件路径", () => {
    expect(src).toContain(OPTS.permissionFile);
  });

  it("包含 agentHome（用于识别控制面写入）", () => {
    expect(src).toContain(OPTS.agentHome);
  });

  it("注册了 tool_call 拦截", () => {
    expect(src).toContain('pi.on("tool_call"');
  });

  it("有 hasUI 检查，无人值守时 fail-closed", () => {
    expect(src).toContain("ctx.hasUI");
    expect(src).toContain("需要审批但没有可用的界面");
  });

  it("读权限档失败时回落 ask", () => {
    expect(src).toMatch(/catch\s*\{[\s\S]*?return "ask"/);
  });

  it("不替换 pi 的系统提示，只做拦截", () => {
    expect(src).not.toContain("systemPrompt");
    expect(src).not.toContain("appendSystemPrompt");
  });

  it("不 import 宿主的任何模块", () => {
    const imports = src.match(/^import .*$/gm) ?? [];
    for (const line of imports) {
      expect(line).toMatch(/from "(node:|\.)/);
    }
  });
});

describe("常量", () => {
  it("文件名与 title 固定，宿主靠它们识别", () => {
    expect(RAKKO_BRIDGE_FILENAME).toBe("rakko-bridge.ts");
    expect(RAKKO_PERMISSION_TITLE).toBe("rakko:permission");
  });

  it("三个决定的字面量互不相同", () => {
    const set = new Set([RAKKO_ALLOW_ONCE, RAKKO_ALLOW_TYPE, RAKKO_DENY]);
    expect(set.size).toBe(3);
  });

  it("决定字面量带 rakko: 前缀，不会和别的扩展撞", () => {
    expect(RAKKO_ALLOW_ONCE.startsWith("rakko:")).toBe(true);
    expect(RAKKO_DENY.startsWith("rakko:")).toBe(true);
  });
});

describe("路径转义", () => {
  it("Windows 反斜杠路径被正确转义", () => {
    const winSrc = buildBridgeSource({
      permissionFile: "C:\\Users\\x\\agent-home\\runtime\\perm.json",
      agentHome: "C:\\Users\\x\\agent-home",
    });
    // 必须是可解析的 JS 字符串字面量，不能是裸反斜杠
    expect(winSrc).toContain("\\\\");
    expect(parsesAsScript(winSrc)).toBe(true);
  });

  it("含引号的路径不会破坏语法", () => {
    const weird = buildBridgeSource({
      permissionFile: '/tmp/a"b/perm.json',
      agentHome: "/tmp/a\"b",
    });
    expect(parsesAsScript(weird)).toBe(true);
  });
});
