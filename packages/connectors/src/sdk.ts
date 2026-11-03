// Connector SDK. A connector IMPORTS data from a vendor system into Orbit. It is READ-ONLY toward
// the vendor: nothing in this SDK can write back to a milking robot, herd package or sensor.
import type {
  AnimalSex,
  AnimalStatus,
  ConnectorVendor,
  DeviceKind,
  DeviceStatus,
  ObservationKind,
  Species,
} from "@orbit/schema/enums";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { ConnectorConfigError } from "./errors";

export const CONNECTOR_CATEGORIES = [
  "milking_robot",
  "herd_software",
  "wearable",
  "camera",
  "file_import",
] as const;
export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

/**
 * Entities are addressed by the vendor's own id (externalId). The host maps (connector, externalId)
 * to Orbit UUIDs, so re-running a sync updates rows instead of duplicating them.
 */
export interface AnimalUpsert {
  externalId: string;
  species: Species;
  name?: string;
  earTagNumber?: string;
  nationalId?: string;
  breed?: string;
  sex?: AnimalSex;
  /** YYYY-MM-DD */
  birthDate?: string;
  groupName?: string;
  status?: AnimalStatus;
  notes?: string;
}

export interface DeviceUpsert {
  externalId: string;
  kind: DeviceKind;
  vendor?: string;
  model?: string;
  serial?: string;
  status?: DeviceStatus;
  batteryPct?: number;
  lastSeenAt?: string;
  /** Connection details. Never secrets. */
  connection?: Record<string, unknown>;
}

export interface DeviceBind {
  deviceExternalId: string;
  animalExternalId: string;
  /** ISO-8601 UTC; defaults to now. */
  boundAt?: string;
}

export interface ObservationInput {
  animalExternalId?: string;
  deviceExternalId?: string;
  kind: ObservationKind;
  /** ISO-8601 UTC */
  ts: string;
  valueNum?: number;
  valueJson?: Record<string, unknown>;
}

/**
 * Typed write surface handed to a connector. Referenced animals and devices must be upserted
 * first. bindDevice enforces the domain rule: an animal has at most ONE active wearable
 * (collar OR bolus OR ear tag sensor); a second one makes bindDevice throw SingleWearableError.
 */
export interface ConnectorWriter {
  upsertAnimal(animal: AnimalUpsert): Promise<void>;
  upsertDevice(device: DeviceUpsert): Promise<void>;
  bindDevice(binding: DeviceBind): Promise<void>;
  addObservations(observations: readonly ObservationInput[]): Promise<void>;
}

export interface ConnectorLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const silentLogger: ConnectorLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export const consoleLogger: ConnectorLogger = {
  debug: (m, f) => console.debug(m, f ?? ""),
  info: (m, f) => console.info(m, f ?? ""),
  warn: (m, f) => console.warn(m, f ?? ""),
  error: (m, f) => console.error(m, f ?? ""),
};

export interface ConnectorContext<C> {
  connectorId: string;
  /** Validated against the connector's configSchema. Secrets are never in here. */
  config: C;
  writer: ConnectorWriter;
  logger: ConnectorLogger;
  /** Long-running work must observe this and stop promptly. */
  signal: AbortSignal;
}

export interface TestResult {
  ok: boolean;
  message: string;
}

export interface ConnectorDefinition<S extends TSchema> {
  /** Stable id, e.g. "lely_t4c". */
  id: string;
  vendor: ConnectorVendor;
  kind: ConnectorCategory;
  label?: string;
  /** typebox schema of the non-secret config. */
  configSchema: S;
  /** Cheap, side-effect-free check that the source is reachable and readable. */
  test(ctx: ConnectorContext<Static<S>>): Promise<TestResult>;
  /** Import everything available from the source through ctx.writer. */
  sync(ctx: ConnectorContext<Static<S>>): Promise<void>;
}

export interface Connector<S extends TSchema = TSchema> extends ConnectorDefinition<S> {
  /** Validates raw config against configSchema or throws ConnectorConfigError. */
  parseConfig(raw: unknown): Static<S>;
}

export function defineConnector<S extends TSchema>(def: ConnectorDefinition<S>): Connector<S> {
  return {
    ...def,
    parseConfig(raw: unknown): Static<S> {
      if (Value.Check(def.configSchema, raw)) return raw as Static<S>;
      const issues = Value.Errors(def.configSchema, raw).map(
        (e) => `${e.instancePath || "(config)"} ${e.message}`,
      );
      throw new ConnectorConfigError(`invalid config for connector ${def.id}`, issues);
    },
  };
}

export interface RunOptions {
  rawConfig: unknown;
  writer: ConnectorWriter;
  connectorId?: string;
  logger?: ConnectorLogger;
  signal?: AbortSignal;
}

export interface SyncCounts {
  animals: number;
  devices: number;
  bindings: number;
  observations: number;
}

function makeContext<S extends TSchema>(connector: Connector<S>, opts: RunOptions) {
  return {
    connectorId: opts.connectorId ?? connector.id,
    config: connector.parseConfig(opts.rawConfig),
    writer: opts.writer,
    logger: opts.logger ?? silentLogger,
    signal: opts.signal ?? new AbortController().signal,
  };
}

/** Host-side helper: validate config, then run connector.test. */
export function runTest<S extends TSchema>(
  connector: Connector<S>,
  opts: RunOptions,
): Promise<TestResult> {
  return connector.test(makeContext(connector, opts));
}

/** Host-side helper: validate config, run connector.sync and count what was written. */
export async function runSync<S extends TSchema>(
  connector: Connector<S>,
  opts: RunOptions,
): Promise<SyncCounts> {
  const counts: SyncCounts = { animals: 0, devices: 0, bindings: 0, observations: 0 };
  const inner = opts.writer;
  const counting: ConnectorWriter = {
    async upsertAnimal(a) {
      await inner.upsertAnimal(a);
      counts.animals++;
    },
    async upsertDevice(d) {
      await inner.upsertDevice(d);
      counts.devices++;
    },
    async bindDevice(b) {
      await inner.bindDevice(b);
      counts.bindings++;
    },
    async addObservations(o) {
      await inner.addObservations(o);
      counts.observations += o.length;
    },
  };
  await connector.sync(makeContext(connector, { ...opts, writer: counting }));
  return counts;
}
