import type { ParsedTable } from "./csv";
import { ConnectorParseError } from "./errors";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e] ?? "").trim();

/**
 * Minimal reader for flat XML exports: every <recordTag> element becomes one row whose columns are
 * its attributes plus its direct text-only child elements. Not a general XML parser.
 */
export function parseXmlRecords(text: string, recordTag: string): ParsedTable {
  const tag = recordTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, "g");
  const headers: string[] = [];
  const rows: Record<string, string>[] = [];
  for (const m of text.matchAll(re)) {
    const row: Record<string, string> = {};
    for (const a of (m[1] ?? "").matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
      row[a[1] as string] = decode(a[2] as string);
    }
    for (const c of (m[2] ?? "").matchAll(/<([\w:.-]+)>([^<]*)<\/\1>/g)) {
      row[c[1] as string] = decode(c[2] as string);
    }
    for (const k of Object.keys(row)) if (!headers.includes(k)) headers.push(k);
    rows.push(row);
  }
  if (rows.length === 0) throw new ConnectorParseError(`no <${recordTag}> elements found`);
  for (const r of rows) for (const h of headers) r[h] ??= "";
  return { headers, rows };
}
