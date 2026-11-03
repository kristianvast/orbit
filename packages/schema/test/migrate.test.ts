import { expect, test } from "bun:test";
import { LOCAL_ONLY_TABLES, SYNCED_TABLES } from "../src/enums";
import { migrate, openLocalDb } from "../src/local";

test("migrations apply on an in-memory bun:sqlite db and are idempotent", () => {
  const db = openLocalDb(":memory:");
  const first = migrate(db);
  expect(first.applied.length).toBeGreaterThan(0);
  expect(migrate(db).applied).toEqual([]);
  const tables = db.$client
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);
  for (const t of [...SYNCED_TABLES, ...LOCAL_ONLY_TABLES]) expect(tables).toContain(t);
  const indexes = db.$client
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((r) => r.name);
  expect(indexes).toContain("device_bindings_one_active_wearable_per_animal");
});
