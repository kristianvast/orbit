import type { ReactNode } from "react";

interface CodeFenceBlock {
  kind: "code";
  lang: string;
  code: string;
}

interface TableBlock {
  kind: "table";
  headers: string[];
  rows: string[][];
}

interface HeadingBlock {
  kind: "heading";
  level: 2 | 3 | 4;
  text: string;
}

interface ListBlock {
  kind: "list";
  ordered: boolean;
  items: string[];
}

interface ParagraphBlock {
  kind: "paragraph";
  text: string;
}

type MarkdownBlock = CodeFenceBlock | TableBlock | HeadingBlock | ListBlock | ParagraphBlock;

function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  const seen = new Map<string, number>();
  return parts.map((part) => {
    const count = (seen.get(part) ?? 0) + 1;
    seen.set(part, count);
    const key = `inline-${part.slice(0, 16)}-${count}`;
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      return (
        <code
          key={key}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.9em",
            padding: "0.1rem 0.35rem",
            borderRadius: "var(--radius-sm)",
            backgroundColor: "var(--bg-subtle)",
            border: "1px solid var(--border-subtle)",
          }}
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length >= 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\||\|$/g, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const cells = splitTableRow(trimmed);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({
        kind: "code",
        lang,
        code: codeLines.join("\n"),
      });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1] ?? "")) {
      const headers = splitTableRow(line);
      const rows: string[][] = [];
      i += 2;
      while (
        i < lines.length &&
        (lines[i] ?? "").trim().includes("|") &&
        (lines[i] ?? "").trim().length > 0
      ) {
        rows.push(splitTableRow(lines[i] ?? ""));
        i++;
      }
      blocks.push({
        kind: "table",
        headers,
        rows,
      });
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const hashes = headingMatch[1]?.length ?? 2;
      const level: 2 | 3 | 4 = hashes <= 2 ? 2 : hashes === 3 ? 3 : 4;
      blocks.push({
        kind: "heading",
        level,
        text: headingMatch[2] ?? "",
      });
      i++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push({
        kind: "list",
        ordered: false,
        items,
      });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push({
        kind: "list",
        ordered: true,
        items,
      });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !(lines[i] ?? "").trim().startsWith("```") &&
      !/^(#{1,4})\s+/.test(lines[i] ?? "") &&
      !/^\s*[-*]\s+/.test(lines[i] ?? "") &&
      !/^\s*\d+\.\s+/.test(lines[i] ?? "") &&
      !(
        (lines[i] ?? "").includes("|") &&
        i + 1 < lines.length &&
        isTableSeparator(lines[i + 1] ?? "")
      )
    ) {
      paraLines.push(lines[i] ?? "");
      i++;
    }
    blocks.push({
      kind: "paragraph",
      text: paraLines.join("\n"),
    });
  }

  return blocks;
}

export function SafeMarkdown({ text }: { text: string }) {
  const blocks = parseMarkdownBlocks(text);

  if (blocks.length === 0) {
    return null;
  }

  let blockSeq = 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
        fontSize: "var(--text-base)",
        lineHeight: "var(--leading-body)",
        color: "var(--text-primary)",
      }}
    >
      {blocks.map((block) => {
        blockSeq += 1;
        const key = `md-${blockSeq}-${block.kind}`;
        if (block.kind === "code") {
          return (
            <div
              key={key}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-1)",
              }}
            >
              {block.lang && (
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs)",
                    color: "var(--text-muted)",
                  }}
                >
                  {block.lang}
                </span>
              )}
              <pre className="orbit-code-block">
                <code>{block.code}</code>
              </pre>
            </div>
          );
        }

        if (block.kind === "table") {
          let headerSeq = 0;
          let rowSeq = 0;
          return (
            <div key={key} className="orbit-mini-table-wrap">
              <table className="orbit-mini-table">
                <thead>
                  <tr>
                    {block.headers.map((header) => {
                      headerSeq += 1;
                      return <th key={`th-${header}-${headerSeq}`}>{renderInline(header)}</th>;
                    })}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row) => {
                    rowSeq += 1;
                    let cellSeq = 0;
                    const rowKey = `tr-${row.join("|")}-${rowSeq}`;
                    return (
                      <tr key={rowKey}>
                        {row.map((cell) => {
                          cellSeq += 1;
                          return (
                            <td key={`${rowKey}-td-${cell}-${cellSeq}`}>{renderInline(cell)}</td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        }

        if (block.kind === "heading") {
          const Tag = block.level === 2 ? "h3" : block.level === 3 ? "h4" : "h5";
          return (
            <Tag
              key={key}
              style={{
                margin: "var(--space-2) 0 0 0",
                fontFamily: "var(--font-display)",
                fontSize: block.level === 2 ? "var(--text-h3)" : "var(--text-lg)",
                fontWeight: 650,
                lineHeight: "var(--leading-heading)",
              }}
            >
              {renderInline(block.text)}
            </Tag>
          );
        }

        if (block.kind === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          let itemSeq = 0;
          return (
            <ListTag
              key={key}
              style={{
                margin: 0,
                paddingInlineStart: "var(--space-5)",
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-1)",
              }}
            >
              {block.items.map((item) => {
                itemSeq += 1;
                return <li key={`li-${item.slice(0, 20)}-${itemSeq}`}>{renderInline(item)}</li>;
              })}
            </ListTag>
          );
        }

        return (
          <p
            key={key}
            style={{
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {renderInline(block.text)}
          </p>
        );
      })}
    </div>
  );
}
