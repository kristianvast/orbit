import { ConnectorParseError } from "./errors";

export interface ParsedTable {
  headers: string[];
  rows: Record<string, string>[];
}

/** Picks the most frequent of , ; tab in the header line (European exports use ";"). */
export function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  let best = ",";
  let bestCount = 0;
  for (const d of [",", ";", "\t"]) {
    const n = first.split(d).length - 1;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/** RFC 4180 parser: quoted fields, doubled quotes, CRLF/LF, BOM, blank lines skipped. */
export function parseCsv(text: string, opts: { delimiter?: string } = {}): ParsedTable {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const d = opts.delimiter ?? detectDelimiter(src);
  const records: string[][] = [];
  let rec: string[] = [];
  let field = "";
  let quoted = false;
  const endRecord = () => {
    rec.push(field);
    field = "";
    if (!(rec.length === 1 && rec[0]?.trim() === "")) records.push(rec);
    rec = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === d) {
      rec.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      endRecord();
    } else field += c;
  }
  if (quoted) throw new ConnectorParseError("CSV ends inside a quoted field");
  if (field !== "" || rec.length > 0) endRecord();

  const head = records[0];
  if (!head) throw new ConnectorParseError("file is empty: no header row");
  const headers = head.map((h) => h.trim());
  const rows = records.slice(1).map((r) => {
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (r[i] ?? "").trim();
    });
    return row;
  });
  return { headers, rows };
}
