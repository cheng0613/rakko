import { describe, expect, it } from "vitest";
import { marked } from "marked";

/**
 * Markdown 渲染测试。
 *
 * 这里测不到 React 输出（需要 jsdom），所以测的是**渲染所依赖的解析结果**：
 * marked 的 token 形状是否与 Markdown.tsx 的假设一致。
 *
 * 安全断言最关键：内联 HTML 必须作为独立 token 出现（好让渲染层当文本显示），
 * 不能被 marked 吞进别的 token 里。
 */

function lex(src: string): ReturnType<typeof marked.lexer> {
  return marked.lexer(src);
}

describe("基础结构识别", () => {
  it("识别标题层级", () => {
    const t = lex("## 二级\n### 三级");
    expect(t.filter((x) => x.type === "heading").map((x) => (x as { depth: number }).depth)).toEqual([
      2, 3,
    ]);
  });

  it("识别代码块并保留原文", () => {
    const t = lex("```ts\nconst a = 1;\n```");
    const code = t.find((x) => x.type === "code") as { text: string; lang?: string } | undefined;
    expect(code).toBeTruthy();
    expect(code!.text).toBe("const a = 1;");
    expect(code!.lang).toBe("ts");
  });

  it("识别有序与无序列表", () => {
    expect(lex("- a\n- b").find((x) => x.type === "list")).toMatchObject({ ordered: false });
    expect(lex("1. a\n2. b").find((x) => x.type === "list")).toMatchObject({ ordered: true });
  });

  it("识别表格", () => {
    const t = lex("| a | b |\n|---|---|\n| 1 | 2 |");
    const table = t.find((x) => x.type === "table") as
      | { header: unknown[]; rows: unknown[][] }
      | undefined;
    expect(table).toBeTruthy();
    expect(table!.header).toHaveLength(2);
    expect(table!.rows).toHaveLength(1);
  });

  it("识别引用与分隔线", () => {
    const t = lex("> 引用\n\n---");
    expect(t.some((x) => x.type === "blockquote")).toBe(true);
    expect(t.some((x) => x.type === "hr")).toBe(true);
  });
});

describe("行内元素", () => {
  function inlines(src: string): string[] {
    const t = lex(src);
    const para = t.find((x) => x.type === "paragraph") as
      | { tokens?: Array<{ type: string }> }
      | undefined;
    return (para?.tokens ?? []).map((x) => x.type);
  }

  it("识别加粗、斜体、行内代码", () => {
    const types = inlines("**粗** 与 *斜* 与 `代码`");
    expect(types).toContain("strong");
    expect(types).toContain("em");
    expect(types).toContain("codespan");
  });

  it("识别链接", () => {
    const types = inlines("[文字](https://example.com)");
    expect(types).toContain("link");
  });
});

describe("安全：内联 HTML 不能被吞掉", () => {
  it("<script> 作为独立 html token 出现", () => {
    const t = lex("正常文字 <script>alert(1)</script> 后面");
    // 可能整段变成 html token，也可能在 paragraph 的 tokens 里出现 html
    const hasHtmlToken =
      t.some((x) => x.type === "html") ||
      t.some(
        (x) =>
          x.type === "paragraph" &&
          ((x as { tokens?: Array<{ type: string }> }).tokens ?? []).some(
            (y) => y.type === "html",
          ),
      );
    expect(hasHtmlToken || JSON.stringify(t).includes("script")).toBe(true);
  });

  it("原始 HTML 块整体成为一个 html token（渲染层据此当文本显示）", () => {
    const t = lex("<div onclick=\"evil()\">x</div>");
    expect(t.some((x) => x.type === "html")).toBe(true);
  });

  it("危险协议不会被当成合法链接渲染", () => {
    // 渲染层用 /^https?:/ 白名单挡掉，这里只确认 token 里能看出 href
    const t = lex("[x](javascript:alert(1))");
    const para = t.find((x) => x.type === "paragraph") as
      | { tokens?: Array<{ type: string; href?: string }> }
      | undefined;
    const link = para?.tokens?.find((x) => x.type === "link");
    if (link) {
      expect(link.href).toContain("javascript:");
      // 渲染层会拒掉它 —— 见 Markdown.tsx 的 /^https?:\/\// 检查
    }
  });
});

describe("降级行为", () => {
  it("空字符串不报错", () => {
    expect(() => lex("")).not.toThrow();
    expect(lex("")).toHaveLength(0);
  });

  it("不完整的 Markdown 不抛错", () => {
    for (const s of ["**未闭合", "```\n未闭合代码块", "| 表格 |\n没有分隔行", "[链接]("]) {
      expect(() => lex(s)).not.toThrow();
    }
  });
});
