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

describe("凭证路径检测（防止静默读 key）", () => {
  /**
   * 直接验证【生成的源码】里的逻辑，不是验证我们自己的实现。
   *
   * 这段代码要经过「模板字符串 → 生成源码 → 运行时」三层，
   * 之前就在这里翻过车：`\b` 被吃成退格符、`\` 变成 `\`。
   * 所以必须测生成后的产物。
   */
  function loadDetector(): (input: unknown) => boolean {
    const src = buildBridgeSource({ permissionFile: "/tmp/p.json", agentHome: "/tmp/ah" });
    const start = src.indexOf("const CREDENTIAL_MARKERS");
    const fnStart = src.indexOf("function touchesCredentialPath", start);
    let depth = 0;
    let fnEnd = -1;
    for (let i = src.indexOf("{", fnStart); i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          fnEnd = i + 1;
          break;
        }
      }
    }
    const code = `${src.slice(start, fnEnd)}\nreturn touchesCredentialPath;`;
    // eslint-disable-next-line no-new-func
    return new Function(code)() as (input: unknown) => boolean;
  }

  const detect = loadDetector();

  it.each([
    ["/home/u/.ssh/id_rsa", true],
    ["/home/u/.aws/credentials", true],
    ["/home/u/.gnupg/private-keys-v1.d/x.key", true],
    ["/home/u/.kube/config", true],
    ["/home/u/.docker/config.json", true],
    ["/home/u/.npmrc", true],
    ["/home/u/.netrc", true],
    ["/home/u/.git-credentials", true],
    ["/home/u/.pi/auth.json", true],
    ["/app/.env", true],
    ["/app/.env.local", true],
    ["/repo/.m2/settings.xml", true],
    ["/repo/.config/gh/hosts.yml", true],
    ["/home/u/project/notes.txt", false],
    ["/home/u/projects/my-ssh-tool/x.ts", false],
    ["src/index.ts", false],
  ])("%s → %s", (pathStr, expected) => {
    expect(detect({ path: pathStr })).toBe(expected);
  });

  it("bash 的 command 字段也能检测到", () => {
    expect(detect({ command: "cat ~/.ssh/id_rsa" })).toBe(true);
    expect(detect({ command: "cat /proc/1234/environ" })).toBe(true);
    expect(detect({ command: "ls -la" })).toBe(false);
  });

  it("grep 的 pattern 字段也能检测到", () => {
    expect(detect({ pattern: "key", path: "/home/u/.ssh" })).toBe(true);
  });

  it("任意字符串字段都会被扫描（不只 path）", () => {
    expect(detect({ content: '读取 "/home/u/.env" 里的值' })).toBe(true);
  });

  it("Windows 反斜杠路径也能命中", () => {
    expect(detect({ path: "C:\\Users\\u\\.ssh\\id_rsa" })).toBe(true);
    expect(detect({ path: "C:\\Users\\u\\.env" })).toBe(true);
  });

  it("null / undefined / 空对象不报错也不命中", () => {
    expect(detect(null)).toBe(false);
    expect(detect(undefined)).toBe(false);
    expect(detect({})).toBe(false);
    expect(detect("")).toBe(false);
  });
});
