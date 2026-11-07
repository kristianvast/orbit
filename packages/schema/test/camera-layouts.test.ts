import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate, openLocalDb } from "../src/local";
import { cameraLayouts } from "../src/sqlite";

test("camera layouts allow only one live row per farm and retain soft-deleted rows", () => {
  const db = openLocalDb(":memory:");
  migrate(db);
  const row = {
    id: "layout-1",
    farmId: "farm-1",
    layout: { version: 2, tiles: [] },
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
    hlc: "01793923200000:000000:local",
    originDevice: "local",
  };
  try {
    db.insert(cameraLayouts).values(row).run();
    expect(() =>
      db
        .insert(cameraLayouts)
        .values({ ...row, id: "layout-2" })
        .run(),
    ).toThrow();
    db.update(cameraLayouts)
      .set({ deletedAt: row.updatedAt })
      .where(eq(cameraLayouts.id, row.id))
      .run();
    db.insert(cameraLayouts)
      .values({ ...row, id: "layout-2" })
      .run();
    expect(db.select().from(cameraLayouts).all()).toHaveLength(2);
  } finally {
    db.$client.close(true);
  }
});
