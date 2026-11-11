// Named read queries and writes exposed over db.query / db.mutate. No raw SQL crosses the wire.
import type {
  Animal,
  Camera,
  Connector,
  Device,
  DeviceBinding,
  DeviceKind,
  Farm,
  Observation,
  WearableKind,
} from "@orbit/schema";
import { DEVICE_KINDS, SPECIES } from "@orbit/schema/enums";
import { type Static, Type } from "typebox";
import {
  AnimalInput,
  CameraInput,
  CameraMapLayout,
  ConnectorInput,
  DeviceInput,
  ObservationKindSchema,
} from "./model";

const Limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 }));

export const DbQueries = {
  "farm.summary": Type.Object({}),
  "animals.list": Type.Object({
    species: Type.Optional(Type.Enum([...SPECIES])),
    status: Type.Optional(Type.Enum(["active", "sold", "dead"])),
    groupName: Type.Optional(Type.String()),
    /** Matches name, ear tag number or national id. */
    search: Type.Optional(Type.String()),
    limit: Limit,
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
  "animals.get": Type.Object({ id: Type.String() }),
  "devices.list": Type.Object({ kind: Type.Optional(Type.Enum([...DEVICE_KINDS])) }),
  "bindings.list": Type.Object({
    animalId: Type.Optional(Type.String()),
    deviceId: Type.Optional(Type.String()),
    /** Default true. */
    activeOnly: Type.Optional(Type.Boolean()),
  }),
  "connectors.list": Type.Object({}),
  "observations.recent": Type.Object({
    animalId: Type.Optional(Type.String()),
    kind: Type.Optional(ObservationKindSchema),
    /** ISO timestamp lower bound. */
    since: Type.Optional(Type.String()),
    alertsOnly: Type.Optional(Type.Boolean()),
    limit: Limit,
  }),
  "cameras.list": Type.Object({}),
  /** Whether the local video relay (go2rtc) can serve live camera streams. */
  "cameras.relay": Type.Object({}),
  "cameraLayout.get": Type.Object({}),
} as const;
export type DbQueryName = keyof typeof DbQueries;
export const DB_QUERY_NAMES = Object.keys(DbQueries) as DbQueryName[];
export type DbQueryParams<Q extends DbQueryName> = Static<(typeof DbQueries)[Q]>;

export const DbMutations = {
  "observations.add": Type.Object({
    animalId: Type.Optional(Type.String()),
    kind: ObservationKindSchema,
    ts: Type.String(),
    valueNum: Type.Optional(Type.Number()),
    valueJson: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }),
  "animals.upsert": Type.Object({ animal: AnimalInput }),
  "devices.upsert": Type.Object({ device: DeviceInput }),
  /** Binds a device to an animal. Fails with rule_violation if the animal already wears a wearable. */
  "bindings.set": Type.Object({ deviceId: Type.String(), animalId: Type.String() }),
  /** Ends the active binding of the device. */
  "bindings.clear": Type.Object({ deviceId: Type.String() }),
  "connectors.upsert": Type.Object({ connector: ConnectorInput }),
  "connectors.syncNow": Type.Object({ id: Type.String() }),
  "cameras.upsert": Type.Object({ camera: CameraInput }),
  /** Replaces the farm's barn-map layout. */
  "cameraLayout.save": Type.Object({ layout: CameraMapLayout }),
  "farm.update": Type.Object({
    name: Type.Optional(Type.String({ minLength: 1 })),
    timezone: Type.Optional(Type.String({ minLength: 1 })),
  }),
} as const;
export type DbMutationName = keyof typeof DbMutations;
export const DB_MUTATION_NAMES = Object.keys(DbMutations) as DbMutationName[];
export type DbMutationParams<M extends DbMutationName> = Static<(typeof DbMutations)[M]>;

/** Wire params of db.query: { query, params }. */
export const DbQueryRequest = Type.Union(
  DB_QUERY_NAMES.map((q) =>
    Type.Object({ query: Type.Literal(q), params: Type.Optional(DbQueries[q]) }),
  ),
);
export const DbMutateRequest = Type.Union(
  DB_MUTATION_NAMES.map((m) => Type.Object({ mutation: Type.Literal(m), params: DbMutations[m] })),
);
export type DbQueryRequest = {
  [Q in DbQueryName]: { query: Q; params?: DbQueryParams<Q> };
}[DbQueryName];
export type DbMutateRequest = {
  [M in DbMutationName]: { mutation: M; params: DbMutationParams<M> };
}[DbMutationName];

// ------------------------------------------------------------------ result shapes (row types from @orbit/schema)

export interface ActiveWearable {
  deviceId: string;
  kind: WearableKind;
  vendor: string | null;
  batteryPct: number | null;
}

export interface FarmSummary {
  farm: Farm | null;
  counts: {
    cattle: number;
    horses: number;
    devices: number;
    devicesOffline: number;
    cameras: number;
    camerasOnline: number;
    connectors: number;
    connectorsWithErrors: number;
  };
  /** Alerts (health_event, calving_alert, heat_alert) from the last 7 days, newest first. */
  recentAlerts: Observation[];
}

export type AnimalListItem = Animal & { wearable: ActiveWearable | null };
export type DeviceListItem = Device & { boundAnimalId: string | null };

export interface DbQueryResults {
  "farm.summary": FarmSummary;
  "animals.list": { rows: AnimalListItem[]; total: number };
  "animals.get": {
    animal: Animal;
    wearable: ActiveWearable | null;
    bindings: DeviceBinding[];
    devices: Device[];
    recentObservations: Observation[];
  };
  "devices.list": { rows: DeviceListItem[] };
  "bindings.list": { rows: (DeviceBinding & { deviceKind: DeviceKind })[] };
  "connectors.list": { rows: Connector[] };
  "observations.recent": { rows: Observation[] };
  "cameras.list": { rows: Camera[] };
  "cameras.relay": CameraRelayStatus;
  "cameraLayout.get": { layout: CameraMapLayout | null };
}

/**
 * Live video relay state. Streams are served by Orion at
 * /camera/<token>/<cameraId>/ws (go2rtc MSE WebSocket) and /camera/<token>/<cameraId>/frame.jpeg.
 */
export interface CameraRelayStatus {
  available: boolean;
  /** Why the relay is unavailable (e.g. go2rtc binary not found); null when available. */
  reason: string | null;
}

export const DbMutateResult = Type.Object({
  /** Ids of rows written (created ids for inserts). */
  ids: Type.Array(Type.String()),
  /** Snapshot that can undo this write; null for non-undoable ops (e.g. connectors.syncNow). */
  snapshotId: Type.Union([Type.String(), Type.Null()]),
});
export type DbMutateResult = Static<typeof DbMutateResult>;
