// Value conversion between the wire (Electric shapes / Core write API) and local SQLite.
// Wire rows use SQL column names. Electric sends Postgres text values ("t"/"f", numbers as
// strings, timestamptz as "2026-11-03 10:00:00+00"); already-parsed values are accepted too.
import type { SyncedTable } from "@orbit/schema";
import { type ColumnMeta, TABLE_COLUMNS } from "./columns";

export type LocalValue = string | number | null;
export type LocalRow = Record<string, LocalValue>;
export type WireRow = Record<string, unknown>;

export class RowError extends Error {
  override name = "RowError";
}

const PG_TS =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** Normalises a Postgres timestamptz text value (or any ISO string) to ISO-8601 UTC with ms. */
export function normalizeTimestamp(value: string): string {
  const m = PG_TS.exec(value.trim());
  let parsed: number;
  if (m) {
    const [, date, time, frac = "", tzRaw] = m;
    const ms = `${frac}000`.slice(0, 3);
    let tz = tzRaw ? tzRaw.toUpperCase() : "Z";
    if (tz !== "Z") {
      const digits = tz.slice(1).replace(":", "");
      tz = `${tz[0]}${digits.slice(0, 2)}:${(digits.slice(2) || "00").padEnd(2, "0")}`;
    }
    const hms = (time as string).length === 5 ? `${time}:00` : time;
    parsed = Date.parse(`${date}T${hms}.${ms}${tz}`);
  } else {
    parsed = Date.parse(value);
  }
  if (Number.isNaN(parsed)) throw new RowError(`invalid timestamp: ${value}`);
  return new Date(parsed).toISOString();
}

function toBoolean(v: unknown): boolean {
  if (v === true || v === 1 || v === "t" || v === "true" || v === "1") return true;
  if (v === false || v === 0 || v === "f" || v === "false" || v === "0") return false;
  throw new RowError(`invalid boolean: ${String(v)}`);
}

/** Converts one wire value into the representation stored in local SQLite. */
export function toLocalValue(col: ColumnMeta, v: unknown): LocalValue {
  if (v === null || v === undefined) return null;
  switch (col.kind) {
    case "timestamp":
      return normalizeTimestamp(String(v));
    case "boolean":
      return toBoolean(v) ? 1 : 0;
    case "real": {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) throw new RowError(`invalid number in ${col.sqlName}: ${String(v)}`);
      return n;
    }
    case "json":
      if (typeof v === "string") {
        JSON.parse(v); // validate; stored verbatim
        return v;
      }
      return JSON.stringify(v);
    default:
      return String(v);
  }
}

/** Converts one local SQLite value (or a Drizzle-typed value) into its wire representation. */
export function toWireValue(col: ColumnMeta, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (col.kind) {
    case "boolean":
      return toBoolean(v);
    case "json":
      return typeof v === "string" ? JSON.parse(v) : v;
    case "real":
      return typeof v === "number" ? v : Number(v);
    default:
      return v;
  }
}

function pick(row: Record<string, unknown>, col: ColumnMeta): unknown {
  return col.sqlName in row ? row[col.sqlName] : row[col.tsKey];
}

/** Wire (or Drizzle) row -> local SQLite row keyed by SQL name. Missing columns become null. */
export function toLocalRow(table: SyncedTable, row: Record<string, unknown>): LocalRow {
  const out: LocalRow = {};
  for (const col of TABLE_COLUMNS[table]) out[col.sqlName] = toLocalValue(col, pick(row, col));
  return out;
}

/** Local SQLite row or Drizzle row (camelCase) -> wire row keyed by SQL name. */
export function toWireRow(table: SyncedTable, row: Record<string, unknown>): WireRow {
  const out: WireRow = {};
  for (const col of TABLE_COLUMNS[table]) {
    const v = pick(row, col);
    if (v !== undefined) out[col.sqlName] = toWireValue(col, v);
  }
  return out;
}
