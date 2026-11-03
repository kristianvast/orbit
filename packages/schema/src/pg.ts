// Cloud Postgres schema (Core). Column names are identical to ./sqlite.ts for every synced table.
// Local-only tables (outbox, snapshots, sync_state) do not exist here.
// Timestamps are timestamptz in "string" mode; @orbit/sync normalises them to ISO-8601 before
// writing them into local SQLite.
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  ANIMAL_SEX,
  ANIMAL_STATUS,
  CAMERA_STATUS,
  CONNECTOR_KINDS,
  CONNECTOR_VENDORS,
  DEVICE_KINDS,
  DEVICE_STATUS,
  OBSERVATION_KINDS,
  SPECIES,
} from "./enums";
import type { JsonObject } from "./sqlite";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

const syncColumns = () => ({
  farmId: uuid("farm_id").notNull(),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
  deletedAt: ts("deleted_at"),
  hlc: text("hlc").notNull(),
  originDevice: text("origin_device").notNull(),
});

export const farms = pgTable("farms", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  ...syncColumns(),
});

export const animals = pgTable(
  "animals",
  {
    id: uuid("id").primaryKey(),
    species: text("species", { enum: SPECIES }).notNull(),
    name: text("name"),
    earTagNumber: text("ear_tag_number"),
    nationalId: text("national_id"),
    breed: text("breed"),
    sex: text("sex", { enum: ANIMAL_SEX }).notNull().default("unknown"),
    birthDate: date("birth_date", { mode: "string" }),
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

export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind", { enum: DEVICE_KINDS }).notNull(),
    vendor: text("vendor"),
    model: text("model"),
    serial: text("serial"),
    connection: jsonb("connection").$type<JsonObject>(),
    status: text("status", { enum: DEVICE_STATUS }).notNull().default("offline"),
    batteryPct: doublePrecision("battery_pct"),
    lastSeenAt: ts("last_seen_at"),
    ...syncColumns(),
  },
  (t) => [index("devices_farm_idx").on(t.farmId), index("devices_kind_idx").on(t.farmId, t.kind)],
);

export const deviceBindings = pgTable(
  "device_bindings",
  {
    id: uuid("id").primaryKey(),
    deviceId: uuid("device_id").notNull(),
    animalId: uuid("animal_id").notNull(),
    wearable: boolean("wearable").notNull(),
    boundAt: ts("bound_at").notNull(),
    unboundAt: ts("unbound_at"),
    ...syncColumns(),
  },
  (t) => [
    index("device_bindings_animal_idx").on(t.animalId),
    uniqueIndex("device_bindings_one_active_wearable_per_animal")
      .on(t.animalId)
      .where(sql`${t.wearable} = true and ${t.unboundAt} is null and ${t.deletedAt} is null`),
    uniqueIndex("device_bindings_one_active_binding_per_device")
      .on(t.deviceId)
      .where(sql`${t.unboundAt} is null and ${t.deletedAt} is null`),
  ],
);

export const connectors = pgTable(
  "connectors",
  {
    id: uuid("id").primaryKey(),
    vendor: text("vendor", { enum: CONNECTOR_VENDORS }).notNull(),
    kind: text("kind", { enum: CONNECTOR_KINDS }).notNull(),
    name: text("name"),
    config: jsonb("config").$type<JsonObject>().notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),
    lastSyncAt: ts("last_sync_at"),
    lastError: text("last_error"),
    ...syncColumns(),
  },
  (t) => [index("connectors_farm_idx").on(t.farmId)],
);

export const observations = pgTable(
  "observations",
  {
    id: uuid("id").primaryKey(),
    animalId: uuid("animal_id"),
    deviceId: uuid("device_id"),
    kind: text("kind", { enum: OBSERVATION_KINDS }).notNull(),
    ts: ts("ts").notNull(),
    valueNum: doublePrecision("value_num"),
    valueJson: jsonb("value_json").$type<JsonObject>(),
    source: text("source").notNull(),
    ...syncColumns(),
  },
  (t) => [
    index("observations_animal_ts_idx").on(t.animalId, t.ts),
    index("observations_farm_kind_ts_idx").on(t.farmId, t.kind, t.ts),
  ],
);

export const cameras = pgTable(
  "cameras",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    location: text("location"),
    onvifXaddr: text("onvif_xaddr"),
    rtspUrl: text("rtsp_url"),
    credentialRef: text("credential_ref"),
    status: text("status", { enum: CAMERA_STATUS }).notNull().default("unknown"),
    ...syncColumns(),
  },
  (t) => [index("cameras_farm_idx").on(t.farmId)],
);

export const pgSchema = {
  farms,
  animals,
  devices,
  deviceBindings,
  connectors,
  observations,
  cameras,
};

export const pgSyncedTables = {
  farms,
  animals,
  devices,
  device_bindings: deviceBindings,
  connectors,
  observations,
  cameras,
} as const;

export type PgFarm = typeof farms.$inferSelect;
export type PgAnimal = typeof animals.$inferSelect;
export type PgDevice = typeof devices.$inferSelect;
export type PgDeviceBinding = typeof deviceBindings.$inferSelect;
export type PgConnector = typeof connectors.$inferSelect;
export type PgObservation = typeof observations.$inferSelect;
export type PgCamera = typeof cameras.$inferSelect;
