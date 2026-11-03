// In-memory ConnectorWriter for tests and dry runs. Mirrors the host's rules.
import { findWearableConflict, SingleWearableError } from "@orbit/schema";
import { ConnectorWriteError } from "./errors";
import type {
  AnimalUpsert,
  ConnectorWriter,
  DeviceBind,
  DeviceUpsert,
  ObservationInput,
} from "./sdk";

export interface MemoryBinding extends DeviceBind {
  boundAt: string;
  unboundAt: string | null;
}

export interface MemoryWriter extends ConnectorWriter {
  animals: Map<string, AnimalUpsert>;
  devices: Map<string, DeviceUpsert>;
  bindings: MemoryBinding[];
  observations: ObservationInput[];
  activeBindings(): MemoryBinding[];
}

export function createMemoryWriter(
  now: () => string = () => new Date().toISOString(),
): MemoryWriter {
  const animals = new Map<string, AnimalUpsert>();
  const devices = new Map<string, DeviceUpsert>();
  const bindings: MemoryBinding[] = [];
  const observations: ObservationInput[] = [];
  const active = () => bindings.filter((b) => b.unboundAt === null);

  return {
    animals,
    devices,
    bindings,
    observations,
    activeBindings: active,
    async upsertAnimal(a) {
      animals.set(a.externalId, { ...animals.get(a.externalId), ...a });
    },
    async upsertDevice(d) {
      devices.set(d.externalId, { ...devices.get(d.externalId), ...d });
    },
    async bindDevice(b) {
      const device = devices.get(b.deviceExternalId);
      if (!device) throw new ConnectorWriteError(`unknown device ${b.deviceExternalId}`);
      if (!animals.has(b.animalExternalId)) {
        throw new ConnectorWriteError(`unknown animal ${b.animalExternalId}`);
      }
      const current = active();
      if (
        current.some(
          (x) =>
            x.deviceExternalId === b.deviceExternalId && x.animalExternalId === b.animalExternalId,
        )
      ) {
        return;
      }
      const conflict = findWearableConflict(
        { deviceId: b.deviceExternalId, animalId: b.animalExternalId, kind: device.kind },
        current.flatMap((x) => {
          const kind = devices.get(x.deviceExternalId)?.kind;
          return kind ? [{ deviceId: x.deviceExternalId, animalId: x.animalExternalId, kind }] : [];
        }),
      );
      if (conflict) {
        throw new SingleWearableError(b.animalExternalId, conflict.deviceId, conflict.kind);
      }
      const at = b.boundAt ?? now();
      // A device is bound to at most one animal at a time: moving it ends the old binding.
      for (const x of current) if (x.deviceExternalId === b.deviceExternalId) x.unboundAt = at;
      bindings.push({ ...b, boundAt: at, unboundAt: null });
    },
    async addObservations(list) {
      for (const o of list) {
        if (o.animalExternalId && !animals.has(o.animalExternalId)) {
          throw new ConnectorWriteError(`unknown animal ${o.animalExternalId}`);
        }
        if (o.deviceExternalId && !devices.has(o.deviceExternalId)) {
          throw new ConnectorWriteError(`unknown device ${o.deviceExternalId}`);
        }
        observations.push(o);
      }
    },
  };
}
