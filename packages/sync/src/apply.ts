// Applies incoming shape rows to local SQLite with per-row last-writer-wins by HLC, and resolves
// the single-active-wearable / single-active-binding-per-device rule: the binding with the newer
// HLC stays active, the older one is ended locally and that end is queued in the outbox.
import type { Database } from "bun:sqlite";
import {
  compare,
  type Hlc,
  HlcError,
  isWearableKind,
  parseHlc,
  type SyncedTable,
} from "@orbit/schema";
import { TABLE_COLUMNS } from "./columns";
import { type LocalRow, RowError, toLocalRow, toWireRow } from "./convert";

export type ApplyOutcome = "applied" | "stale" | "invalid";

export interface ApplyContext {
  client: Database;
  clock: Hlc;
  farmId: string;
  now: () => Date;
}

const upsertSql = new Map<string, string>();

function upsertStatement(table: SyncedTable, guarded: boolean): string {
  const key = `${table}:${guarded}`;
  let sql = upsertSql.get(key);
  if (!sql) {
    const cols = TABLE_COLUMNS[table].map((c) => c.sqlName);
    const quoted = cols.map((c) => `"${c}"`).join(", ");
    const sets = cols
      .filter((c) => c !== "id")
      .map((c) => `"${c}" = excluded."${c}"`)
      .join(", ");
    sql = `INSERT INTO "${table}" (${quoted}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT("id") DO UPDATE SET ${sets}${guarded ? ` WHERE excluded."hlc" > "${table}"."hlc"` : ""}`;
    upsertSql.set(key, sql);
  }
  return sql;
}

function upsert(ctx: ApplyContext, table: SyncedTable, row: LocalRow, guarded: boolean): boolean {
  const values = TABLE_COLUMNS[table].map((c) => row[c.sqlName] ?? null);
  return ctx.client.query(upsertStatement(table, guarded)).run(...values).changes > 0;
}

/** Writes a row produced by sync itself (conflict resolution) and queues it for Core. */
function writeLocalChange(ctx: ApplyContext, table: SyncedTable, row: LocalRow): void {
  upsert(ctx, table, row, false);
  ctx.client
    .query(
      `INSERT INTO "outbox" ("op", "table_name", "row_id", "payload", "hlc", "attempts", "created_at") VALUES ('update', ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      table,
      row.id as string,
      JSON.stringify(toWireRow(table, row)),
      row.hlc as string,
      ctx.now().toISOString(),
    );
}

function endBinding(ctx: ApplyContext, row: LocalRow, unboundAt: string): LocalRow {
  return {
    ...row,
    unbound_at: unboundAt,
    updated_at: ctx.now().toISOString(),
    hlc: ctx.clock.tick(),
    origin_device: ctx.clock.node,
  };
}

function isActiveBinding(row: LocalRow): boolean {
  return row.unbound_at === null && row.deleted_at === null;
}

function deviceIsWearable(ctx: ApplyContext, row: LocalRow): boolean {
  if (row.wearable !== null) return row.wearable === 1;
  const device = ctx.client
    .query<{ kind: string }, [string]>(`SELECT "kind" FROM "devices" WHERE "id" = ?`)
    .get(row.device_id as string);
  return device ? isWearableKind(device.kind) : false;
}

/**
 * Ends whichever side of a binding conflict is older. Returns the (possibly ended) incoming row.
 */
function resolveBindingConflicts(ctx: ApplyContext, incoming: LocalRow): LocalRow {
  if (!isActiveBinding(incoming)) return incoming;
  const wearable = deviceIsWearable(ctx, incoming) ? 1 : 0;
  const conflicts = ctx.client
    .query<LocalRow, [string, string, number, string]>(
      `SELECT * FROM "device_bindings" WHERE "id" <> ? AND "unbound_at" IS NULL AND "deleted_at" IS NULL
       AND ("device_id" = ? OR (? = 1 AND "wearable" = 1 AND "animal_id" = ?))`,
    )
    .all(
      incoming.id as string,
      incoming.device_id as string,
      wearable,
      incoming.animal_id as string,
    );
  let result = incoming;
  for (const local of conflicts) {
    if (compare(local.hlc as string, result.hlc as string) < 0) {
      writeLocalChange(ctx, "device_bindings", endBinding(ctx, local, result.bound_at as string));
    } else if (isActiveBinding(result)) {
      result = endBinding(ctx, result, local.bound_at as string);
    }
  }
  return result;
}

/** Applies one incoming wire row. Never overwrites a local row whose HLC is equal or newer. */
export function applyIncomingRow(
  ctx: ApplyContext,
  table: SyncedTable,
  wire: Record<string, unknown>,
): ApplyOutcome {
  let row: LocalRow;
  try {
    row = toLocalRow(table, wire);
    if (typeof row.id !== "string" || typeof row.hlc !== "string") return "invalid";
    if (row.farm_id !== ctx.farmId) return "invalid";
    parseHlc(row.hlc);
  } catch (err) {
    if (err instanceof RowError || err instanceof HlcError || err instanceof SyntaxError) {
      return "invalid";
    }
    throw err;
  }
  const existing = ctx.client
    .query<{ hlc: string }, [string]>(`SELECT "hlc" FROM "${table}" WHERE "id" = ?`)
    .get(row.id);
  if (existing && compare(existing.hlc, row.hlc) >= 0) return "stale";
  try {
    ctx.clock.receive(row.hlc);
  } catch (err) {
    // A remote clock far ahead still wins LWW; we just do not let it drag the local clock.
    if (!(err instanceof HlcError)) throw err;
  }
  if (table === "device_bindings") {
    const resolved = resolveBindingConflicts(ctx, row);
    if (resolved !== row) {
      writeLocalChange(ctx, table, resolved);
      return "applied";
    }
  }
  return upsert(ctx, table, row, true) ? "applied" : "stale";
}
