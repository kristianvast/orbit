import { expect, test } from "bun:test";
import { cameraLayouts, outbox } from "@orbit/schema";
import { createSyncEngine } from "../src";
import { FARM, FakeCore, freshDb, hlcAt, TOKEN } from "./fake-core";

test("camera layouts sync JSON from shapes and push the stored layout through the outbox", async () => {
  const core = new FakeCore();
  const db = freshDb();
  const layout = { version: 2, tiles: [{ i: "barn", x: 10, y: 20, w: 400 }] };
  const hlc = hlcAt("2026-11-04T00:00:00Z");
  const engine = createSyncEngine({
    db,
    farmId: FARM,
    coreUrl: core.url,
    token: TOKEN,
    nodeId: "local",
  });
  try {
    core.emit("camera_layouts", {
      id: FARM,
      farm_id: FARM,
      layout: JSON.stringify(layout),
      created_at: "2026-11-04 00:00:00+00",
      updated_at: "2026-11-04 00:00:00+00",
      deleted_at: null,
      hlc,
      origin_device: "cloud",
    });

    expect(await engine.syncNow()).toMatchObject({ ok: true, pulled: 1 });
    const row = db.select().from(cameraLayouts).get();
    expect(row?.layout).toEqual(layout);
    if (!row) throw new TypeError("missing layout");
    db.insert(outbox)
      .values({
        op: "update",
        table: "camera_layouts",
        rowId: row.id,
        payload: row,
        hlc: row.hlc,
        createdAt: row.createdAt,
      })
      .run();
    expect(await engine.syncNow()).toMatchObject({ ok: true, pushed: 1 });
    expect(core.pushes[0]?.[0]).toMatchObject({
      table: "camera_layouts",
      row: { id: FARM, farm_id: FARM, layout },
    });
  } finally {
    await engine.stop();
    core.stop();
    db.$client.close(true);
  }
});
