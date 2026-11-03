import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { animals, deviceBindings, devices } from "../src/sqlite";
import { assertSingleWearable, findWearableConflict, SingleWearableError } from "../src/wearable";
import { FARM, freshDb, sync } from "./helpers";

function setup() {
  const db = freshDb();
  db.insert(animals)
    .values({ id: "cow-1", species: "cattle", name: "Bella", ...sync() })
    .run();
  for (const [id, kind] of [
    ["collar-1", "collar"],
    ["bolus-1", "bolus"],
    ["tag-1", "ear_tag_sensor"],
    ["scale-1", "scale"],
  ] as const) {
    db.insert(devices)
      .values({ id, kind, ...sync() })
      .run();
  }
  const bind = (id: string, deviceId: string, wearable: boolean) =>
    db
      .insert(deviceBindings)
      .values({
        id,
        deviceId,
        animalId: "cow-1",
        wearable,
        boundAt: "2026-11-01T00:00:00Z",
        ...sync(),
      })
      .run();
  return { db, bind };
}

describe("single wearable per animal", () => {
  test("partial unique index rejects a second active wearable", () => {
    const { bind } = setup();
    bind("b1", "collar-1", true);
    expect(() => bind("b2", "bolus-1", true)).toThrow(/UNIQUE/);
  });

  test("non-wearable devices may be bound alongside a wearable", () => {
    const { bind } = setup();
    bind("b1", "collar-1", true);
    expect(() => bind("b2", "scale-1", false)).not.toThrow();
  });

  test("after unbinding, a different wearable may be bound", () => {
    const { db, bind } = setup();
    bind("b1", "collar-1", true);
    db.update(deviceBindings)
      .set({ unboundAt: "2026-11-02T00:00:00Z" })
      .where(eq(deviceBindings.id, "b1"))
      .run();
    expect(() => assertSingleWearable(db, { deviceId: "tag-1", animalId: "cow-1" })).not.toThrow();
    expect(() => bind("b2", "tag-1", true)).not.toThrow();
  });

  test("assertSingleWearable throws a readable error before the constraint", () => {
    const { db, bind } = setup();
    bind("b1", "collar-1", true);
    let err: unknown;
    try {
      assertSingleWearable(db, { deviceId: "bolus-1", animalId: "cow-1" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SingleWearableError);
    expect((err as SingleWearableError).existingKind).toBe("collar");
    // Re-asserting the already bound device is fine, as are non-wearables.
    expect(() =>
      assertSingleWearable(db, { deviceId: "collar-1", animalId: "cow-1" }),
    ).not.toThrow();
    expect(() =>
      assertSingleWearable(db, { deviceId: "scale-1", animalId: "cow-1" }),
    ).not.toThrow();
    expect(() => assertSingleWearable(db, { deviceId: "nope", animalId: "cow-1" })).toThrow(
      /not found/,
    );
  });

  test("findWearableConflict (pure)", () => {
    const active = [{ deviceId: "c", animalId: "a", kind: "collar" as const }];
    expect(findWearableConflict({ deviceId: "b", animalId: "a", kind: "bolus" }, active)).toEqual(
      active[0] ?? null,
    );
    expect(
      findWearableConflict({ deviceId: "s", animalId: "a", kind: "scale" }, active),
    ).toBeNull();
    expect(
      findWearableConflict({ deviceId: "b", animalId: "other", kind: "bolus" }, active),
    ).toBeNull();
    expect(FARM).toBeString();
  });
});
