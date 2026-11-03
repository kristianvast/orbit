import { createHlc } from "../src/hlc";
import { type LocalDb, migrate, openLocalDb } from "../src/local";

export function freshDb(): LocalDb {
  const db = openLocalDb(":memory:");
  migrate(db);
  return db;
}

const clock = createHlc("test", { now: () => Date.parse("2026-11-03T00:00:00Z") });
export const FARM = "00000000-0000-4000-8000-000000000001";
export function sync() {
  return {
    farmId: FARM,
    createdAt: "2026-11-03T00:00:00.000Z",
    updatedAt: "2026-11-03T00:00:00.000Z",
    hlc: clock.tick(),
    originDevice: "test",
  };
}
