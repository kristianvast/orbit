import { expect, test } from "bun:test";
import { getTableConfig as pgConfig } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteConfig } from "drizzle-orm/sqlite-core";
import { SYNCED_TABLES } from "../src/enums";
import { pgSyncedTables } from "../src/pg";
import { sqliteSyncedTables } from "../src/sqlite";

const SYNC_COLUMNS = ["farm_id", "created_at", "updated_at", "deleted_at", "hlc", "origin_device"];

test.each([...SYNCED_TABLES])("%s has identical columns in sqlite and pg", (name) => {
  const s = sqliteConfig(sqliteSyncedTables[name]);
  const p = pgConfig(pgSyncedTables[name]);
  expect(s.name).toBe(name);
  expect(p.name).toBe(name);
  const sCols = s.columns.map((c) => c.name).sort();
  expect(p.columns.map((c) => c.name).sort()).toEqual(sCols);
  for (const c of SYNC_COLUMNS) expect(sCols).toContain(c);
  const nullable = (cols: { name: string; notNull: boolean }[]) =>
    Object.fromEntries(cols.map((c) => [c.name, c.notNull]));
  expect(nullable(p.columns)).toEqual(nullable(s.columns));
  expect(p.indexes.map((i) => i.config.name).sort()).toEqual(
    s.indexes.map((i) => i.config.name).sort(),
  );
});
