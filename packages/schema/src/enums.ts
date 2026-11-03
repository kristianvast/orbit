// Domain enums shared by the SQLite schema, the Postgres schema and @orbit/protocol.
// Pure constants: safe to import from the browser.

export const SPECIES = ["cattle", "horse"] as const;
export type Species = (typeof SPECIES)[number];

export const ANIMAL_SEX = ["female", "male", "castrated", "unknown"] as const;
export type AnimalSex = (typeof ANIMAL_SEX)[number];

export const ANIMAL_STATUS = ["active", "sold", "dead"] as const;
export type AnimalStatus = (typeof ANIMAL_STATUS)[number];

export const DEVICE_KINDS = [
  "milking_robot",
  "collar",
  "bolus",
  "ear_tag_sensor",
  "camera",
  "feeder",
  "scale",
  "other",
] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/** Wearable sensor kinds. DOMAIN RULE: an animal wears at most ONE of these at a time. */
export const WEARABLE_KINDS = [
  "collar",
  "bolus",
  "ear_tag_sensor",
] as const satisfies readonly DeviceKind[];
export type WearableKind = (typeof WEARABLE_KINDS)[number];

export function isWearableKind(kind: string): kind is WearableKind {
  return (WEARABLE_KINDS as readonly string[]).includes(kind);
}

export const DEVICE_STATUS = ["online", "offline", "error", "retired"] as const;
export type DeviceStatus = (typeof DEVICE_STATUS)[number];

export const CONNECTOR_VENDORS = [
  "lely",
  "delaval",
  "gea",
  "boumatic",
  "allflex",
  "smaxtec",
  "cowmanager",
  "generic_csv",
  "custom",
] as const;
export type ConnectorVendor = (typeof CONNECTOR_VENDORS)[number];

/** How a connector reaches its data: vendor cloud API, a LAN API/database, a file drop, or custom code. */
export const CONNECTOR_KINDS = [
  "cloud_api",
  "local_api",
  "local_db",
  "file_import",
  "custom",
] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export const OBSERVATION_KINDS = [
  "milking",
  "activity",
  "rumination",
  "temperature",
  "weight",
  "health_event",
  "calving_alert",
  "heat_alert",
] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export const ALERT_KINDS = [
  "health_event",
  "calving_alert",
  "heat_alert",
] as const satisfies readonly ObservationKind[];

export const CAMERA_STATUS = ["online", "offline", "error", "unknown"] as const;
export type CameraStatus = (typeof CAMERA_STATUS)[number];

export const OUTBOX_OPS = ["insert", "update", "delete"] as const;
export type OutboxOp = (typeof OUTBOX_OPS)[number];

/** Tables replicated between local SQLite and cloud Postgres (identical column names in both). */
export const SYNCED_TABLES = [
  "farms",
  "animals",
  "devices",
  "device_bindings",
  "connectors",
  "observations",
  "cameras",
] as const;
export type SyncedTable = (typeof SYNCED_TABLES)[number];

/** Tables that exist only in the local SQLite database. */
export const LOCAL_ONLY_TABLES = ["outbox", "snapshots", "sync_state"] as const;
export type LocalOnlyTable = (typeof LOCAL_ONLY_TABLES)[number];
