import { describe, expect, it } from "vitest";
import {
  BYPASS_WARNING,
  PERMISSION_MODES,
  STRICTEST_PERMISSION_MODE,
  coercePermissionMode,
  isPermissionMode,
} from "../permission.js";

describe("权限档顺序", () => {
  it("第一个必须是最严档 ask", () => {
    expect(PERMISSION_MODES[0]).toBe("ask");
  });

  it("必须是从严到宽", () => {
    expect([...PERMISSION_MODES]).toEqual(["ask", "auto", "bypassPermissions"]);
  });

  it("最宽档必须排最后", () => {
    expect(PERMISSION_MODES[PERMISSION_MODES.length - 1]).toBe("bypassPermissions");
  });

  it("STRICTEST 与数组首位一致", () => {
    expect(STRICTEST_PERMISSION_MODE).toBe(PERMISSION_MODES[0]);
  });
});

describe("coercePermissionMode —— 非法值必须落到最严档", () => {
  it("合法值原样返回", () => {
    for (const mode of PERMISSION_MODES) {
      expect(coercePermissionMode(mode)).toBe(mode);
    }
  });

  it("null / undefined / 空串 / 未知字符串都落到 ask", () => {
    for (const bad of [null, undefined, "", "bypass", "BYPASS_PERMISSIONS", 0, {}, []]) {
      expect(coercePermissionMode(bad)).toBe("ask");
    }
  });

  it("绝不因为非法值而放宽到完全访问", () => {
    for (const bad of [null, undefined, "", "unknown", 123]) {
      expect(coercePermissionMode(bad)).not.toBe("bypassPermissions");
    }
  });
});

describe("isPermissionMode", () => {
  it("只认三个字面量", () => {
    expect(isPermissionMode("ask")).toBe(true);
    expect(isPermissionMode("auto")).toBe(true);
    expect(isPermissionMode("bypassPermissions")).toBe(true);
    expect(isPermissionMode("ask ")).toBe(false);
    expect(isPermissionMode("ASK")).toBe(false);
  });
});

describe("完全访问档的文案", () => {
  it("必须明确说明 key 读不到但额度会被消耗", () => {
    expect(BYPASS_WARNING).toContain("读不到你的 key");
    expect(BYPASS_WARNING).toContain("额度");
  });

  it("不得声称完全访问是安全的", () => {
    expect(BYPASS_WARNING).not.toMatch(/安全[^。]*。$/);
  });
});
