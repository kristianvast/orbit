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
  expect(db.select({ vendor: connectors.vendor }).from(connectors).all()).toEqual([
    { vendor: "generic_csv" },
  ]);
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
  // Sensor readings and alerts cover the last week; recorded events reach back a lactation.
  const recorded = ["calving", "insemination", "pregnancy_check", "dry_off", "treatment"];
  const readings = obs.filter((o) => !recorded.includes(o.kind)).map((o) => Date.parse(o.ts));
  expect(now.getTime() - Math.min(...readings)).toBeLessThanOrEqual(8 * 86_400_000);

  // Idempotent and deterministic.
  expect(seedDemoFarm(db, { now }).created).toBe(false);
  const again = freshDb();
  seedDemoFarm(again, { now });
  expect(again.select({ id: animals.id }).from(animals).all()).toEqual(
    db.select({ id: animals.id }).from(animals).all(),
  );
});

test("seedDemoFarm backs each reproduction status with the recorded event", () => {
  const db = freshDb();
  seedDemoFarm(db, { now: new Date("2026-11-03T12:00:00Z") });
  const all = db.select().from(animals).all();
  const withEvent = (kind: "insemination" | "pregnancy_check" | "dry_off" | "calving") =>
    new Set(
      db
        .select({ animalId: observations.animalId })
        .from(observations)
        .where(eq(observations.kind, kind))
        .all()
        .map((o) => o.animalId),
    );
  const missing = (status: (a: (typeof all)[number]) => boolean, events: Set<string | null>) =>
    all.filter((a) => status(a) && !events.has(a.id)).map((a) => a.name);

  const pregnant = all.filter((a) => a.reproductionStatus === "pregnant");
  expect(pregnant.length).toBeGreaterThan(0);
  expect(pregnant.every((a) => a.sex === "female")).toBe(true);
  expect(missing((a) => a.reproductionStatus === "pregnant", withEvent("insemination"))).toEqual(
    [],
  );
  expect(missing((a) => a.reproductionStatus === "pregnant", withEvent("pregnancy_check"))).toEqual(
    [],
  );
  expect(missing((a) => a.reproductionStatus === "inseminated", withEvent("insemination"))).toEqual(
    [],
  );
  expect(missing((a) => a.lactationStatus === "dry", withEvent("dry_off"))).toEqual([]);
  expect(missing((a) => a.lactationStatus === "fresh", withEvent("calving"))).toEqual([]);
});
