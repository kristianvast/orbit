// Local SQLite schema (bun:sqlite). Column names are identical to ./pg.ts for every synced table.
// Conventions: ids are UUID strings, timestamps are ISO-8601 UTC strings, JSON is stored as text.
// Synced tables declare no foreign keys on purpose: Electric shapes arrive table by table in any
// order, so referential integrity is enforced by writers and by Postgres, not by local SQLite.
import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import {
  ANIMAL_SEX,
  ANIMAL_STATUS,
  CAMERA_STATUS,
  CONNECTOR_KINDS,
  CONNECTOR_VENDORS,
  DEVICE_KINDS,
  DEVICE_STATUS,
  OBSERVATION_KINDS,
  OUTBOX_OPS,
  SPECIES,
} from "./enums";

export type JsonObject = { [key: string]: unknown };

/** Sync columns carried by every synced table. */
const syncColumns = () => ({
  farmId: text("farm_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  /** Soft delete: rows are never hard-deleted from synced tables. */
  deletedAt: text("deleted_at"),
  /** Hybrid logical clock of the last write; last-writer-wins per row. */
  hlc: text("hlc").notNull(),
  /** Install id of the Orbit device (or "cloud") that made the last write. */
  originDevice: text("origin_device").notNull(),
});

export const farms = sqliteTable("farms", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  ...syncColumns(),
});

export const animals = sqliteTable(
  "animals",
  {
    id: text("id").primaryKey(),
    species: text("species", { enum: SPECIES }).notNull(),
    name: text("name"),
    earTagNumber: text("ear_tag_number"),
    nationalId: text("national_id"),
    breed: text("breed"),
    sex: text("sex", { enum: ANIMAL_SEX }).notNull().default("unknown"),
    /** YYYY-MM-DD */
    birthDate: text("birth_date"),
    groupName: text("group_name"),
    status: text("status", { enum: ANIMAL_STATUS }).notNull().default("active"),
    notes: text("notes"),
    ...syncColumns(),
  },
  (t) => [
    index("animals_farm_idx").on(t.farmId),
    index("animals_ear_tag_idx").on(t.farmId, t.earTagNumber),
  ],
);

export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: DEVICE_KINDS }).notNull(),
    vendor: text("vendor"),
    model: text("model"),
    serial: text("serial"),
    /** Connection details (host, port, protocol, connector id...). Never secrets. */
    connection: text("connection", { mode: "json" }).$type<JsonObject>(),
    status: text("status", { enum: DEVICE_STATUS }).notNull().default("offline"),
    batteryPct: real("battery_pct"),
    lastSeenAt: text("last_seen_at"),
    ...syncColumns(),
  },
  (t) => [index("devices_farm_idx").on(t.farmId), index("devices_kind_idx").on(t.farmId, t.kind)],
);

export const deviceBindings = sqliteTable(
  "device_bindings",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    animalId: text("animal_id").notNull(),
    /** Denormalised from devices.kind in (collar, bolus, ear_tag_sensor); powers the partial unique index. */
    wearable: integer("wearable", { mode: "boolean" }).notNull(),
    boundAt: text("bound_at").notNull(),
    /** NULL while the binding is active. */
    unboundAt: text("unbound_at"),
    ...syncColumns(),
  },
  (t) => [
    index("device_bindings_animal_idx").on(t.animalId),
    // DOMAIN RULE: at most ONE active wearable sensor per animal.
    uniqueIndex("device_bindings_one_active_wearable_per_animal")
      .on(t.animalId)
      .where(sql`${t.wearable} = 1 and ${t.unboundAt} is null and ${t.deletedAt} is null`),
    // A device is bound to at most one animal at a time.
    uniqueIndex("device_bindings_one_active_binding_per_device")
      .on(t.deviceId)
      .where(sql`${t.unboundAt} is null and ${t.deletedAt} is null`),
  ],
);

export const connectors = sqliteTable(
  "connectors",
  {
    id: text("id").primaryKey(),
    vendor: text("vendor", { enum: CONNECTOR_VENDORS }).notNull(),
    kind: text("kind", { enum: CONNECTOR_KINDS }).notNull(),
    name: text("name"),
    /** Non-secret settings. Secrets live in the OS keychain, referenced by key (e.g. config.credentialRef). */
    config: text("config", { mode: "json" }).$type<JsonObject>().notNull().default({}),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastSyncAt: text("last_sync_at"),
    lastError: text("last_error"),
    ...syncColumns(),
  },
  (t) => [index("connectors_farm_idx").on(t.farmId)],
);

export const observations = sqliteTable(
  "observations",
  {
    id: text("id").primaryKey(),
    animalId: text("animal_id"),
    deviceId: text("device_id"),
    kind: text("kind", { enum: OBSERVATION_KINDS }).notNull(),
    ts: text("ts").notNull(),
    valueNum: real("value_num"),
    valueJson: text("value_json", { mode: "json" }).$type<JsonObject>(),
    /** Producer, e.g. "connector:<id>", "camera:<id>", "manual", "orion", "seed". */
    source: text("source").notNull(),
    ...syncColumns(),
  },
  (t) => [
    index("observations_animal_ts_idx").on(t.animalId, t.ts),
    index("observations_farm_kind_ts_idx").on(t.farmId, t.kind, t.ts),
  ],
);

export const cameras = sqliteTable(
  "cameras",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    location: text("location"),
    onvifXaddr: text("onvif_xaddr"),
    rtspUrl: text("rtsp_url"),
    /** Key into the OS keychain. NEVER the password itself. */
    credentialRef: text("credential_ref"),
    status: text("status", { enum: CAMERA_STATUS }).notNull().default("unknown"),
    ...syncColumns(),
  },
  (t) => [index("cameras_farm_idx").on(t.farmId)],
);

// ---------------------------------------------------------------- local-only tables

/** Local writes waiting to be POSTed to the Core write API, in seq order. */
export const outbox = sqliteTable(
  "outbox",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    op: text("op", { enum: OUTBOX_OPS }).notNull(),
    /** Synced table name, e.g. "animals". Column is named table_name to avoid the SQL keyword. */
    table: text("table_name").notNull(),
    rowId: text("row_id").notNull(),
    /** Full row after the write (for delete: the soft-deleted row). */
    payload: text("payload", { mode: "json" }).$type<JsonObject>().notNull(),
    hlc: text("hlc").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    /** NULL until the Core write API acknowledged the op. */
    ackedAt: text("acked_at"),
  },
  (t) => [index("outbox_pending_idx").on(t.ackedAt, t.seq)],
);

export type SnapshotChange = {
  table: string;
  rowId: string;
  /** Row before the write; null when the write inserted it. */
  before: JsonObject | null;
  after: JsonObject | null;
};

/** Undo log for agent/UI writes (protocol snapshots.list / snapshots.undo). */
export const snapshots = sqliteTable(
  "snapshots",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id"),
    toolCallId: text("tool_call_id"),
    description: text("description").notNull(),
    changes: text("changes", { mode: "json" }).$type<SnapshotChange[]>().notNull(),
    createdAt: text("created_at").notNull(),
    undoneAt: text("undone_at"),
  },
  (t) => [index("snapshots_created_idx").on(t.createdAt)],
);

/** Opaque per-key state for @orbit/sync (Electric shape handles/offsets, last ack, ...). */
export const syncState = sqliteTable("sync_state", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const sqliteSchema = {
  farms,
  animals,
  devices,
  deviceBindings,
  connectors,
  observations,
  cameras,
  outbox,
  snapshots,
  syncState,
};

/** Drizzle table object for each synced table name. */
export const sqliteSyncedTables = {
  farms,
  animals,
  devices,
  device_bindings: deviceBindings,
  connectors,
  observations,
  cameras,
} as const;

export type Farm = typeof farms.$inferSelect;
export type NewFarm = typeof farms.$inferInsert;
export type Animal = typeof animals.$inferSelect;
export type NewAnimal = typeof animals.$inferInsert;
export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
export type DeviceBinding = typeof deviceBindings.$inferSelect;
export type NewDeviceBinding = typeof deviceBindings.$inferInsert;
export type Connector = typeof connectors.$inferSelect;
export type NewConnector = typeof connectors.$inferInsert;
export type Observation = typeof observations.$inferSelect;
export type NewObservation = typeof observations.$inferInsert;
export type Camera = typeof cameras.$inferSelect;
export type NewCamera = typeof cameras.$inferInsert;
export type OutboxEntry = typeof outbox.$inferSelect;
export type NewOutboxEntry = typeof outbox.$inferInsert;
export type Snapshot = typeof snapshots.$inferSelect;
export type NewSnapshot = typeof snapshots.$inferInsert;
export type SyncStateRow = typeof syncState.$inferSelect;
