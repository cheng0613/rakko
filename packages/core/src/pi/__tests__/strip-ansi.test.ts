import { describe, expect, it } from "vitest";
import { stripAnsi } from "../translator.js";

/**
 * ANSI 清理测试。
 *
 * 背景：dogfood 时 `npx vitest` 的输出带颜色码（\u001b[31m 等），
 * 显示在界面上是不可见字符或乱码。翻译层统一清掉。
 */
describe("stripAnsi", () => {
  it("去掉基本颜色码", () => {
    expect(stripAnsi("\u001b[31m红色\u001b[39m")).toBe("红色");
  });

  it("去掉加粗与组合", () => {
    expect(stripAnsi("\u001b[1m\u001b[32mPASS\u001b[39m\u001b[22m 测试")).toBe("PASS 测试");
  });

  it("去掉光标控制", () => {
    expect(stripAnsi("\u001b[2K\u001b[1G覆盖行")).toBe("覆盖行");
  });

  it("去掉 256 色", () => {
    expect(stripAnsi("\u001b[38;5;196m错误\u001b[0m")).toBe("错误");
  });

  it("去掉 OSC 超链接", () => {
    expect(stripAnsi("\u001b]8;;https://x.com\u0007链接\u001b]8;;\u0007")).toBe("链接");
  });

  it("\r\n 归一化成 \n", () => {
    expect(stripAnsi("a\r\nb")).toBe("a\nb");
  });

  it("纯文本原样返回", () => {
    expect(stripAnsi("普通文本，含中文与 English")).toBe("普通文本，含中文与 English");
  });

  it("空字符串不报错", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("只有转义码时返回空串", () => {
    expect(stripAnsi("\u001b[31m\u001b[0m")).toBe("");
  });

  it("不误伤方括号内容", () => {
    expect(stripAnsi("[OK] 通过")).toBe("[OK] 通过");
    expect(stripAnsi("数组[0] 与 [1, 2]")).toBe("数组[0] 与 [1, 2]");
  });
});
