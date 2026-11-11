/**
 * Markdown 渲染。
 *
 * ⚠️ 安全前提：agent 的回复可能包含用户仓库里的任意内容
 * （文件片段、命令输出、网页文本）。**绝不能直接 innerHTML**。
 *
 * 做法：用 marked 解析成 token，再白名单映射成 React 元素。
 * 不经过 HTML 字符串这一层，天然没有 XSS 面。
 *
 * 不支持的特性（有意为之）：
 *   - 内联 HTML（agent 若输出 <script> 会原样显示成文本）
 *   - 图片远程加载（避免隐私泄漏与追踪像素）
 */
import { marked, type Token, type Tokens } from "marked";
import type { JSX } from "react";

/** 把一段 Markdown 渲染成 React 节点 */
export function Markdown({ text }: { text: string }): JSX.Element {
  const tokens = marked.lexer(text);
  return <>{renderBlocks(tokens)}</>;
}

function renderBlocks(tokens: Token[]): JSX.Element[] {
  return tokens.map((t, i) => <Block key={i} token={t} />);
}

function Block({ token }: { token: Token }): JSX.Element | null {
  switch (token.type) {
    case "paragraph": {
      const p = token as Tokens.Paragraph;
      return (
        <p className="md-p">
          <Inline tokens={p.tokens ?? []} />
        </p>
      );
    }

    case "heading": {
      const h = token as Tokens.Heading;
      // 只用到 h1-h4，再深就没意义了
      const Tag = (`h${Math.min(h.depth, 4)}` as "h1" | "h2" | "h3" | "h4");
      return (
        <Tag className={`md-h md-h${Math.min(h.depth, 4)}`}>
          <Inline tokens={h.tokens ?? []} />
        </Tag>
      );
    }

    case "code": {
      const c = token as Tokens.Code;
      return (
        <pre className="md-pre">
          <code>{c.text}</code>
        </pre>
      );
    }

    case "blockquote": {
      const b = token as Tokens.Blockquote;
      return (
        <blockquote className="md-quote">{renderBlocks(b.tokens ?? [])}</blockquote>
      );
    }

    case "list": {
      const l = token as Tokens.List;
      const items = l.items.map((item, i) => (
        <li key={i}>
          {item.tokens.length === 1 && item.tokens[0]?.type === "text" ? (
            <Inline tokens={(item.tokens[0] as Tokens.Text).tokens ?? []} />
          ) : (
            renderBlocks(item.tokens)
          )}
        </li>
      ));
      return l.ordered ? (
        <ol className="md-list" start={typeof l.start === "number" ? l.start : undefined}>
          {items}
        </ol>
      ) : (
        <ul className="md-list">{items}</ul>
      );
    }

    case "table": {
      const t = token as Tokens.Table;
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {t.header.map((cell, i) => (
                  <th key={i} style={{ textAlign: cell.align ?? undefined }}>
                    <Inline tokens={cell.tokens} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci} style={{ textAlign: cell.align ?? undefined }}>
                      <Inline tokens={cell.tokens} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    case "hr":
      return <hr className="md-hr" />;

    case "space":
      return null;

    // 内联 HTML：故意不渲染，按纯文本显示，防止注入
    case "html": {
      const h = token as Tokens.HTML;
      return <p className="md-p md-raw">{h.text}</p>;
    }

    default: {
      // 未知 token：降级成纯文本，不吞内容
      const anyTok = token as unknown as { raw?: string; text?: string };
      const raw = anyTok.raw ?? anyTok.text ?? "";
      return raw ? <p className="md-p md-raw">{raw}</p> : null;
    }
  }
}

function Inline({ tokens }: { tokens: Token[] }): JSX.Element {
  return <>{tokens.map((t, i) => <InlineNode key={i} token={t} />)}</>;
}

function InlineNode({ token }: { token: Token }): JSX.Element | null {
  switch (token.type) {
    case "text": {
      const t = token as Tokens.Text;
      // text token 可能自己还带 tokens（含嵌套的强调/链接）
      if (t.tokens && t.tokens.length > 0) {
        return <Inline tokens={t.tokens} />;
      }
      return <>{t.text}</>;
    }

    case "strong":
      return (
        <strong>
          <Inline tokens={(token as Tokens.Strong).tokens ?? []} />
        </strong>
      );

    case "em":
      return (
        <em>
          <Inline tokens={(token as Tokens.Em).tokens ?? []} />
        </em>
      );

    case "del":
      return (
        <del>
          <Inline tokens={(token as Tokens.Del).tokens ?? []} />
        </del>
      );

    case "codespan":
      return <code className="md-code">{(token as Tokens.Codespan).text}</code>;

    case "br":
      return <br />;

    case "link": {
      const l = token as Tokens.Link;
      // 只允许 http/https，防止 file: / javascript: / 自定义协议
      const safe = /^https?:\/\//i.test(l.href);
      if (!safe) {
        return <span>{l.text}</span>;
      }
      return (
        <a className="md-a" href={l.href} target="_blank" rel="noreferrer noopener">
          <Inline tokens={l.tokens ?? []} />
        </a>
      );
    }

    case "image": {
      // 不加载远程图片：避免追踪像素与隐私泄漏。显示成链接文字。
      const img = token as Tokens.Image;
      return <span className="md-raw">[图片: {img.text || img.href}]</span>;
    }

    case "escape":
      return <>{(token as Tokens.Escape).text}</>;

    case "html": {
      // 内联 HTML 当文本显示，不执行
      const h = token as Tokens.HTML;
      return <span className="md-raw">{h.text}</span>;
    }

    default: {
      const anyTok = token as unknown as { raw?: string; text?: string };
      const raw = anyTok.raw ?? anyTok.text ?? "";
      return raw ? <span>{raw}</span> : null;
    }
  }
}
