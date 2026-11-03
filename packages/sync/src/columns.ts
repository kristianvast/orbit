// Column metadata for every synced table, derived from the @orbit/schema Drizzle definitions so
// the sync engine stays generic: SQL name, TS property name and a value kind for conversion.
import { pg, SYNCED_TABLES, type SyncedTable, sqliteSyncedTables } from "@orbit/schema";
import { getTableColumns } from "drizzle-orm";

export type ColumnKind = "text" | "timestamp" | "date" | "boolean" | "real" | "json";

export interface ColumnMeta {
  sqlName: string;
  tsKey: string;
  kind: ColumnKind;
  notNull: boolean;
}

function kindOf(sqliteType: string, pgType: string | undefined): ColumnKind {
  if (pgType?.startsWith("PgTimestamp")) return "timestamp";
  if (pgType?.startsWith("PgDate")) return "date";
  if (sqliteType === "SQLiteBoolean") return "boolean";
  if (sqliteType === "SQLiteTextJson") return "json";
  if (sqliteType === "SQLiteReal") return "real";
  return "text";
}

function build(table: SyncedTable): ColumnMeta[] {
  const local = getTableColumns(sqliteSyncedTables[table]);
  const cloud = getTableColumns(pg.pgSyncedTables[table]);
  const cloudByName = new Map(Object.values(cloud).map((c) => [c.name, c.columnType]));
  return Object.entries(local).map(([tsKey, c]) => ({
    sqlName: c.name,
    tsKey,
    kind: kindOf(c.columnType, cloudByName.get(c.name)),
    notNull: c.notNull,
  }));
}

export const TABLE_COLUMNS: Record<SyncedTable, ColumnMeta[]> = Object.fromEntries(
  SYNCED_TABLES.map((t) => [t, build(t)]),
) as Record<SyncedTable, ColumnMeta[]>;

export function isSyncedTable(name: string): name is SyncedTable {
  return (SYNCED_TABLES as readonly string[]).includes(name);
}
