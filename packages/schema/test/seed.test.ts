import { expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { ALERT_KINDS, isWearableKind } from "../src/enums";
import { DEMO_FARM_ID, seedDemoFarm } from "../src/seed";
import { animals, cameras, connectors, deviceBindings, devices, observations } from "../src/sqlite";
import { freshDb } from "./helpers";

test("seedDemoFarm creates the demo farm and respects the one-wearable rule", () => {
  const db = freshDb();
  const now = new Date("2026-11-03T12:00:00Z");
  const result = seedDemoFarm(db, { now });
  expect(result.created).toBe(true);
  expect(result.farmId).toBe(DEMO_FARM_ID);

  const all = db.select().from(animals).all();
  expect(all.filter((a) => a.species === "cattle")).toHaveLength(24);
  expect(all.filter((a) => a.species === "horse")).toHaveLength(4);
  expect(db.select().from(cameras).all()).toHaveLength(3);
  expect(db.select().from(connectors).all()).toHaveLength(4);
  expect(db.select().from(devices).where(eq(devices.kind, "milking_robot")).all()).toHaveLength(1);

  const active = db
    .select({ animalId: deviceBindings.animalId, kind: devices.kind })
    .from(deviceBindings)
    .innerJoin(devices, eq(devices.id, deviceBindings.deviceId))
    .where(and(isNull(deviceBindings.unboundAt), isNull(deviceBindings.deletedAt)))
    .all();
  const perAnimal = new Map<string, number>();
  for (const b of active) {
    if (isWearableKind(b.kind)) perAnimal.set(b.animalId, (perAnimal.get(b.animalId) ?? 0) + 1);
  }
  expect(Math.max(...perAnimal.values())).toBe(1);
  const kinds = new Set(active.map((b) => b.kind));
  expect([...kinds].sort()).toEqual(["bolus", "collar", "ear_tag_sensor"]);

  const obs = db.select().from(observations).all();
  expect(obs.length).toBe(result.counts.observations);
  const alerts = obs.filter((o) => (ALERT_KINDS as readonly string[]).includes(o.kind));
  expect(alerts.length).toBeGreaterThanOrEqual(2);
  const ts = obs.map((o) => Date.parse(o.ts));
  expect(Math.max(...ts)).toBeLessThanOrEqual(now.getTime());
  expect(now.getTime() - Math.min(...ts)).toBeLessThanOrEqual(8 * 86_400_000);

  // Idempotent and deterministic.
  expect(seedDemoFarm(db, { now }).created).toBe(false);
  const again = freshDb();
  seedDemoFarm(again, { now });
  expect(again.select({ id: animals.id }).from(animals).all()).toEqual(
    db.select({ id: animals.id }).from(animals).all(),
  );
});
