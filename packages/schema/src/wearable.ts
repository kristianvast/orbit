// DOMAIN RULE: an animal wears a collar OR a bolus OR an ear tag sensor, never several at once.
// Enforced twice: the partial unique index device_bindings_one_active_wearable_per_animal, and
// assertSingleWearable() which writers call first to get a readable error instead of a constraint
// violation.
import { and, eq, isNull, ne } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { type DeviceKind, isWearableKind } from "./enums";
import { deviceBindings, devices } from "./sqlite";

export class SingleWearableError extends Error {
  override name = "SingleWearableError";
  constructor(
    readonly animalId: string,
    readonly existingDeviceId: string,
    readonly existingKind: DeviceKind,
  ) {
    super(
      `animal ${animalId} already wears an active ${existingKind} (device ${existingDeviceId}); unbind it first`,
    );
  }
}

export interface ActiveBindingView {
  deviceId: string;
  animalId: string;
  kind: DeviceKind;
}

/**
 * Pure check usable by any writer (local SQLite or Core/Postgres): returns the conflicting active
 * wearable binding, or null if binding deviceKind/deviceId to animalId is allowed.
 */
export function findWearableConflict(
  candidate: { deviceId: string; animalId: string; kind: DeviceKind },
  activeBindings: readonly ActiveBindingView[],
): ActiveBindingView | null {
  if (!isWearableKind(candidate.kind)) return null;
  return (
    activeBindings.find(
      (b) =>
        b.animalId === candidate.animalId &&
        b.deviceId !== candidate.deviceId &&
        isWearableKind(b.kind),
    ) ?? null
  );
}

// biome-ignore lint/suspicious/noExplicitAny: accepts any drizzle SQLite database (bun:sqlite, libsql, ...)
type AnySqliteDb = BaseSQLiteDatabase<"sync", any, any>;

/**
 * Throws SingleWearableError if binding deviceId to animalId would give the animal a second active
 * wearable. Throws Error if the device does not exist. Call inside the write transaction.
 */
export function assertSingleWearable(
  db: AnySqliteDb,
  binding: { deviceId: string; animalId: string },
): void {
  const device = db
    .select({ kind: devices.kind })
    .from(devices)
    .where(and(eq(devices.id, binding.deviceId), isNull(devices.deletedAt)))
    .get();
  if (!device) throw new Error(`device ${binding.deviceId} not found`);
  if (!isWearableKind(device.kind)) return;
  const conflict = db
    .select({ deviceId: deviceBindings.deviceId, kind: devices.kind })
    .from(deviceBindings)
    .innerJoin(devices, eq(devices.id, deviceBindings.deviceId))
    .where(
      and(
        eq(deviceBindings.animalId, binding.animalId),
        eq(deviceBindings.wearable, true),
        isNull(deviceBindings.unboundAt),
        isNull(deviceBindings.deletedAt),
        ne(deviceBindings.deviceId, binding.deviceId),
      ),
    )
    .get();
  if (conflict) throw new SingleWearableError(binding.animalId, conflict.deviceId, conflict.kind);
}
