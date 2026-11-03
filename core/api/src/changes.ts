// POST /v1/changes: validates pushed outbox rows against the @orbit/schema Postgres tables and
// applies them with per-row last-writer-wins by HLC. Device bindings additionally keep the
// "one active wearable per animal / one active binding per device" rule: the newer binding stays
// active and the older one is ended by Core (with a fresh cloud HLC so the end syncs back).
import {
  compare,
  createHlc,
  type Hlc,
  HlcError,
  isWearableKind,
  OUTBOX_OPS,
  parseHlc,
  pg,
  SYNCED_TABLES,
  type SyncedTable,
} from "@orbit/schema";
import { and, eq, getTableColumns, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { CoreDb } from "./db";

export interface IncomingChange {
  seq: number;
  op: string;
  table: string;
  rowId: string;
  hlc: string;
  row: Record<string, unknown>;
}

export type ChangeStatus = "applied" | "stale" | "rejected" | "conflict";

export interface ChangeResult {
  seq: number;
  status: ChangeStatus;
  error?: string;
}

export const MAX_CHANGES_PER_REQUEST = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class ValidationError extends Error {}

// The synced tables share id/hlc/farm_id columns; Drizzle cannot type a union of tables generically,
// so the dynamic upsert works on this structural view.
type SyncedPgTable = typeof pg.animals;
const tableOf = (name: SyncedTable) => pg.pgSyncedTables[name] as unknown as SyncedPgTable;

function validateValue(col: PgColumn, v: unknown): unknown {
  if (v === null || v === undefined) {
    if (col.notNull && !col.hasDefault) throw new ValidationError(`${col.name} is required`);
    return v === undefined && col.hasDefault ? undefined : null;
  }
  const fail = (what: string) => new ValidationError(`${col.name} must be ${what}`);
  switch (col.columnType) {
    case "PgUUID":
      if (typeof v !== "string" || !UUID.test(v)) throw fail("a uuid");
      return v.toLowerCase();
    case "PgTimestampString": {
      if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw fail("an ISO timestamp");
      return new Date(Date.parse(v)).toISOString();
    }
    case "PgDateString":
      if (typeof v !== "string" || !DATE.test(v)) throw fail("a YYYY-MM-DD date");
      return v;
    case "PgBoolean":
      if (typeof v !== "boolean") throw fail("a boolean");
      return v;
    case "PgDoublePrecision":
      if (typeof v !== "number" || !Number.isFinite(v)) throw fail("a finite number");
      return v;
    case "PgJsonb":
      if (typeof v !== "object") throw fail("a JSON object");
      return v;
    default: {
      if (typeof v !== "string") throw fail("a string");
      const allowed = (col as PgColumn & { enumValues?: string[] }).enumValues;
      if (allowed && allowed.length > 0 && !allowed.includes(v)) {
        throw fail(`one of ${allowed.join(", ")}`);
      }
      return v;
    }
  }
}

/** Validates one change for the token's farm and returns Drizzle insert values (TS keys). */
export function validateChange(change: IncomingChange, farmId: string): Record<string, unknown> {
  if (!(SYNCED_TABLES as readonly string[]).includes(change.table)) {
    throw new ValidationError(`unknown table ${change.table}`);
  }
  if (!(OUTBOX_OPS as readonly string[]).includes(change.op)) {
    throw new ValidationError(`unknown op ${change.op}`);
  }
  const row = change.row;
  if (!row || typeof row !== "object") throw new ValidationError("row must be an object");
  const values: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(getTableColumns(tableOf(change.table as SyncedTable)))) {
    const v = validateValue(col, row[col.name] ?? row[key]);
    if (v !== undefined) values[key] = v;
  }
  if (values.farmId !== farmId) throw new ValidationError("farm_id does not match the token");
  if (change.table === "farms" && values.id !== farmId) {
    throw new ValidationError("farms.id must equal the token's farm");
  }
  if (values.id !== change.rowId.toLowerCase())
    throw new ValidationError("rowId must equal row.id");
  if (values.hlc !== change.hlc) throw new ValidationError("hlc must equal row.hlc");
  try {
    parseHlc(change.hlc);
  } catch {
    throw new ValidationError("invalid hlc");
  }
  if (change.op === "delete" && values.deletedAt == null) {
    throw new ValidationError("delete ops must carry deleted_at (soft delete)");
  }
  return values;
}

type Tx = Parameters<Parameters<CoreDb["transaction"]>[0]>[0];

function isUniqueViolation(err: unknown): boolean {
  for (let e = err as { code?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === "23505") return true;
  }
  return false;
}

async function resolveBindingConflicts(
  tx: Tx,
  clock: Hlc,
  values: Record<string, unknown>,
  now: () => Date,
): Promise<Record<string, unknown>> {
  if (values.unboundAt != null || values.deletedAt != null) return values;
  const b = pg.deviceBindings;
  const [device] = await tx
    .select({ kind: pg.devices.kind })
    .from(pg.devices)
    .where(eq(pg.devices.id, values.deviceId as string));
  if (device && isWearableKind(device.kind) !== values.wearable) {
    throw new ValidationError(
      `wearable must be ${isWearableKind(device.kind)} for a ${device.kind}`,
    );
  }
  const sameAnimal: SQL | undefined = values.wearable
    ? and(eq(b.wearable, true), eq(b.animalId, values.animalId as string))
    : undefined;
  const conflicts = await tx
    .select()
    .from(b)
    .where(
      and(
        ne(b.id, values.id as string),
        isNull(b.unboundAt),
        isNull(b.deletedAt),
        sameAnimal
          ? or(eq(b.deviceId, values.deviceId as string), sameAnimal)
          : eq(b.deviceId, values.deviceId as string),
      ),
    )
    .for("update");
  let result = values;
  for (const existing of conflicts) {
    const stamp = { updatedAt: now().toISOString(), hlc: clock.tick(), originDevice: "cloud" };
    if (compare(existing.hlc, result.hlc as string) < 0) {
      await tx
        .update(b)
        .set({ unboundAt: result.boundAt as string, ...stamp })
        .where(eq(b.id, existing.id));
    } else if (result.unboundAt == null) {
      result = { ...result, unboundAt: existing.boundAt, ...stamp };
    }
  }
  return result;
}

export interface ApplyOptions {
  clock?: Hlc;
  now?: () => Date;
}

export function createChangeApplier(db: CoreDb, options: ApplyOptions = {}) {
  const clock = options.clock ?? createHlc("cloud", { maxDriftMs: 24 * 60 * 60 * 1000 });
  const now = options.now ?? (() => new Date());

  async function applyOne(change: IncomingChange, farmId: string): Promise<ChangeResult> {
    let values: Record<string, unknown>;
    try {
      values = validateChange(change, farmId);
      clock.receive(change.hlc);
    } catch (err) {
      if (err instanceof ValidationError || err instanceof HlcError) {
        return { seq: change.seq, status: "rejected", error: err.message };
      }
      throw err;
    }
    const tableName = change.table as SyncedTable;
    const table = tableOf(tableName);
    try {
      return await db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ hlc: table.hlc, farmId: table.farmId })
          .from(table)
          .where(eq(table.id, values.id as string))
          .for("update");
        if (existing && existing.farmId !== farmId) {
          return { seq: change.seq, status: "rejected", error: "id belongs to another farm" };
        }
        if (existing && compare(existing.hlc, values.hlc as string) >= 0) {
          return { seq: change.seq, status: "stale" };
        }
        if (tableName === "device_bindings") {
          values = await resolveBindingConflicts(tx, clock, values, now);
        }
        const set = Object.fromEntries(
          Object.entries(getTableColumns(table))
            .filter(([key]) => key !== "id" && key in values)
            .map(([key, col]) => [key, sql.raw(`excluded."${col.name}"`)]),
        );
        await tx
          .insert(table)
          .values(values as typeof table.$inferInsert)
          .onConflictDoUpdate({
            target: table.id,
            set,
            setWhere: sql`${table.hlc} < excluded."hlc"`,
          });
        return { seq: change.seq, status: "applied" };
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        return { seq: change.seq, status: "rejected", error: err.message };
      }
      if (isUniqueViolation(err)) {
        return { seq: change.seq, status: "conflict", error: "concurrent binding conflict; retry" };
      }
      throw err;
    }
  }

  return async function applyChanges(
    changes: IncomingChange[],
    farmId: string,
  ): Promise<ChangeResult[]> {
    const results: ChangeResult[] = [];
    for (const change of changes) results.push(await applyOne(change, farmId));
    return results;
  };
}
