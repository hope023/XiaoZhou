import { memo, useState } from "react";
import type { ReactNode } from "react";

/* ---------------- 代码块（带复制按钮） ---------------- */

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    // 状态先变，剪贴板失败再用 execCommand 兜底——别让权限问题吞掉反馈
    const fallback = () => {
      const ta = document.createElement("textarea");
      ta.value = code;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).catch(fallback);
    } else {
      fallback();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="md-code-wrap">
      <div className="md-code-bar">
        <span className="md-code-lang">{lang || "代码"}</span>
        <button className="md-code-copy" onClick={copy} type="button">
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="md-code">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/* ---------------- 行内语法 ---------------- */

const INLINE_SOURCE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\s]+\))/.source;

function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // 每次调用都用独立的正则实例：bold/italic 会递归进来，
  // 共用全局正则会互相重置 lastIndex，导致外层原地死循环
  const re = new RegExp(INLINE_SOURCE, "g");
  let last = 0;
  let match: RegExpExecArray | null;
  let seq = 0;

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyBase}-i${seq++}`;

    if (token.startsWith("`")) {
      nodes.push(
        <code className="md-inline-code" key={key}>
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{inline(token.slice(2, -2), key)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{inline(token.slice(1, -1), key)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (link) {
        // 应用内不跳转（避免把 webview 导航走），点击复制链接
        nodes.push(
          <span
            className="md-link"
            key={key}
            title={`${link[2]}（点击复制）`}
            onClick={() => {
              navigator.clipboard?.writeText(link[2]).catch(() => {});
            }}
          >
            {link[1]}
          </span>
        );
      } else {
        nodes.push(token);
      }
    }
    last = match.index + token.length;
  }

  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/* ---------------- 块级语法 ---------------- */

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  if (!line.includes("-")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, "")));
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 空行
    if (!trimmed) {
      i++;
      continue;
    }

    // 代码块
    if (trimmed.startsWith("```")) {
      const lang = trimmed.slice(3).trim();
      const buffer: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        buffer.push(lines[i]);
        i++;
      }
      i++; // 跳过结束围栏
      blocks.push(<CodeBlock key={`b${key++}`} lang={lang} code={buffer.join("\n")} />);
      continue;
    }

    // 标题
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${Math.min(level + 1, 6)}` as "h2";
      blocks.push(
        <Tag className="md-heading" key={`b${key++}`}>
          {inline(heading[2], `b${key}`)}
        </Tag>
      );
      i++;
      continue;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push(<hr className="md-hr" key={`b${key++}`} />);
      i++;
      continue;
    }

    // 表格
    if (trimmed.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitRow(trimmed);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push(
        <div className="md-table-wrap" key={`b${key++}`}>
          <table className="md-table">
            <thead>
              <tr>
                {header.map((cell, ci) => (
                  <th key={ci}>{inline(cell, `th${ci}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {header.map((_, ci) => (
                    <td key={ci}>{inline(row[ci] ?? "", `td${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // 引用
    if (trimmed.startsWith(">")) {
      const buffer: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        buffer.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote className="md-quote" key={`b${key++}`}>
          {buffer.map((line2, li) => (
            <p key={li}>{inline(line2, `q${li}`)}</p>
          ))}
        </blockquote>
      );
      continue;
    }

    // 列表（有序 / 无序，支持一层缩进）
    if (LIST_RE.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: { depth: number; text: string }[] = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m) break;
        const depth = Math.floor(m[1].replace(/\t/g, "  ").length / 2);
        items.push({ depth, text: m[3] });
        i++;
      }
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag className="md-list" key={`b${key++}`}>
          {items.map((item, ii) => (
            <li
              key={ii}
              className="md-list-item"
              style={item.depth > 0 ? { marginLeft: item.depth * 16 } : undefined}
            >
              {inline(item.text, `li${ii}`)}
            </li>
          ))}
        </Tag>
      );
      continue;
    }

    // 普通段落（连续非空行合并）
    const paragraph: string[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      const t = cur.trim();
      if (
        !t ||
        t.startsWith("```") ||
        /^#{1,4}\s/.test(t) ||
        t.startsWith(">") ||
        LIST_RE.test(cur) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(t)
      ) {
        break;
      }
      paragraph.push(t);
      i++;
    }
    if (paragraph.length) {
      blocks.push(
        <p className="md-para" key={`b${key++}`}>
          {inline(paragraph.join("\n"), `p${key}`)}
        </p>
      );
    } else if (!paragraph.length && i < lines.length) {
      // 防御性推进，避免死循环
      i++;
    }
  }

  return <div className="md">{blocks}</div>;
});
