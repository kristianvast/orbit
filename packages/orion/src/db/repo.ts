// Single write path for the local database. Every write runs in one transaction that stamps HLC +
// sync columns, appends the full row to the outbox and records an undo snapshot; db.changed is
// emitted after commit.
import type {
  ActiveWearable,
  AnimalInput,
  CameraInput,
  ConnectorInput,
  DbMutateResult,
  DbMutationParams,
  DbQueryName,
  DbQueryParams,
  DbQueryResults,
  DeviceInput,
  FarmSummary,
  SnapshotSummary,
} from "@orbit/protocol";
import { CameraMapLayout } from "@orbit/protocol";
import {
  ALERT_KINDS,
  type Animal,
  animals,
  assertSingleWearable,
  cameraLayouts,
  cameras,
  connectors,
  createHlc,
  type DeviceKind,
  deviceBindings,
  devices,
  type Farm,
  farms,
  type Hlc,
  isWearableKind,
  type JsonObject,
  type Observation,
  observations,
  outbox,
  SingleWearableError,
  type SnapshotChange,
  snapshots,
  sqliteSyncedTables,
  syncState,
  type WearableKind,
} from "@orbit/schema";
import type { LocalDb } from "@orbit/schema/local";
import { and, count, desc, eq, gte, inArray, isNull, like, or, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { Value } from "typebox/value";

export type SyncedTableName = keyof typeof sqliteSyncedTables;
type Row = Record<string, unknown>;
type AnyTable = SQLiteTable & { id: SQLiteColumn; deletedAt?: SQLiteColumn };

export class RepoError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "rule_violation" | "bad_request" | "not_ready",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface WriteOrigin {
  sessionId?: string | null;
  toolCallId?: string | null;
  /** Human description stored on the snapshot, e.g. "Added animal Bella". */
  description: string;
}

export interface WearableViolation {
  animalId: string;
  animalName: string | null;
  existingDeviceId: string;
  existingKind: DeviceKind;
  requestedDeviceId: string;
  requestedKind: DeviceKind;
}

export type ChangeListener = (table: string, ids: string[]) => void;

const tableOf = (name: SyncedTableName) => sqliteSyncedTables[name] as unknown as AnyTable;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

export class Repository {
  readonly hlc: Hlc;
  private listeners = new Set<ChangeListener>();

  constructor(
    readonly db: LocalDb,
    readonly installId: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.hlc = createHlc(installId);
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(changed: Map<string, Set<string>>) {
    for (const [table, ids] of changed) {
      for (const l of this.listeners) l(table, [...ids]);
    }
  }

  private iso(): string {
    return this.now().toISOString();
  }

  // ------------------------------------------------------------------ farm

  farm(): Farm | null {
    return (
      this.db.select().from(farms).where(isNull(farms.deletedAt)).orderBy(farms.createdAt).get() ??
      null
    );
  }

  /**
   * Drops a local farm that holds nothing but its own row (a placeholder from first start), so a
   * signed-in install can open the account's cloud farm instead. Returns false when it has data.
   */
  discardEmptyFarm(id: string): boolean {
    return this.db.transaction(() => {
      for (const [name, table] of Object.entries(sqliteSyncedTables)) {
        if (name === "farms") continue;
        const t = table as unknown as AnyTable & { farmId: SQLiteColumn };
        const [row] = this.db.select({ n: count() }).from(t).where(eq(t.farmId, id)).all();
        if ((row?.n ?? 0) > 0) return false;
      }
      this.db
        .delete(outbox)
        .where(and(eq(outbox.table, "farms"), eq(outbox.rowId, id)))
        .run();
      this.db.delete(farms).where(eq(farms.id, id)).run();
      return true;
    });
  }

  /** The farm every local write belongs to; creates "My farm" on first use. */
  ensureFarm(): Farm {
    const existing = this.farm();
    if (existing) return existing;
    const id = crypto.randomUUID();
    this.write("farms", id, { name: "My farm", timezone: "UTC" }, { description: "Created farm" });
    return this.farm() as Farm;
  }

  // ------------------------------------------------------------------ generic write

  private getRow(name: SyncedTableName, id: string): Row | null {
    const t = tableOf(name);
    return (this.db.select().from(t).where(eq(t.id, id)).get() as Row | undefined) ?? null;
  }

  /**
   * Inserts or patches one row inside the current transaction and returns the change. Must be
   * called from within `transact`.
   */
  private applyWrite(name: SyncedTableName, id: string, patch: Row): SnapshotChange {
    const t = tableOf(name);
    const before = this.getRow(name, id);
    const ts = this.iso();
    const hlc = this.hlc.tick();
    const stamp = { updatedAt: ts, hlc, originDevice: this.installId };
    if (before) {
      this.db
        .update(t)
        .set({ ...patch, ...stamp } as never)
        .where(eq(t.id, id))
        .run();
    } else {
      const farmId = name === "farms" ? id : this.ensureFarmInTx().id;
      this.db
        .insert(t)
        .values({ ...patch, id, farmId, createdAt: ts, ...stamp } as never)
        .run();
    }
    const after = this.getRow(name, id) as Row;
    this.db
      .insert(outbox)
      .values({
        op: before ? (patch.deletedAt ? "delete" : "update") : "insert",
        table: name,
        rowId: id,
        payload: after as JsonObject,
        hlc,
        createdAt: ts,
      })
      .run();
    return {
      table: name,
      rowId: id,
      before: before as JsonObject | null,
      after: after as JsonObject,
    };
  }

  private ensureFarmInTx(): Farm {
    const existing = this.farm();
    if (existing) return existing;
    const id = crypto.randomUUID();
    this.applyWrite("farms", id, { name: "My farm", timezone: "UTC" });
    return this.farm() as Farm;
  }

  /** Runs fn in a transaction, stores one snapshot for all changes, emits db.changed after commit. */
  private transact<T>(
    origin: WriteOrigin | null,
    fn: (write: (name: SyncedTableName, id: string, patch: Row) => void) => T,
  ): { value: T; snapshotId: string | null; changes: SnapshotChange[] } {
    const changes: SnapshotChange[] = [];
    let snapshotId: string | null = null;
    const value = this.db.transaction(() => {
      const result = fn((name, id, patch) => {
        changes.push(this.applyWrite(name, id, patch));
      });
      if (origin && changes.length > 0) {
        snapshotId = crypto.randomUUID();
        this.db
          .insert(snapshots)
          .values({
            id: snapshotId,
            sessionId: origin.sessionId ?? null,
            toolCallId: origin.toolCallId ?? null,
            description: origin.description,
            changes,
            createdAt: this.iso(),
          })
          .run();
      }
      return result;
    });
    const changed = new Map<string, Set<string>>();
    for (const c of changes) {
      const set = changed.get(c.table) ?? new Set();
      set.add(c.rowId);
      changed.set(c.table, set);
    }
    this.emit(changed);
    return { value, snapshotId, changes };
  }

  private write(name: SyncedTableName, id: string, patch: Row, origin: WriteOrigin) {
    return this.transact(origin, (w) => w(name, id, patch));
  }

  // ------------------------------------------------------------------ queries

  query<Q extends DbQueryName>(name: Q, params: DbQueryParams<Q> | undefined): DbQueryResults[Q] {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (name) {
      case "farm.summary":
        return this.farmSummary() as DbQueryResults[Q];
      case "animals.list":
        return this.listAnimals(p as DbQueryParams<"animals.list">) as DbQueryResults[Q];
      case "animals.get":
        return this.getAnimal(p.id as string) as DbQueryResults[Q];
      case "devices.list":
        return this.listDevices(p.kind as DeviceKind | undefined) as DbQueryResults[Q];
      case "bindings.list":
        return this.listBindings(p as DbQueryParams<"bindings.list">) as DbQueryResults[Q];
      case "connectors.list":
        return { rows: this.listConnectors() } as DbQueryResults[Q];
      case "observations.recent":
        return {
          rows: this.recentObservations(p as DbQueryParams<"observations.recent">),
        } as DbQueryResults[Q];
      case "cameras.list":
        return {
          rows: this.db
            .select()
            .from(cameras)
            .where(isNull(cameras.deletedAt))
            .orderBy(cameras.name)
            .all(),
        } as DbQueryResults[Q];
      case "cameraLayout.get":
        return { layout: this.cameraLayout() } as DbQueryResults[Q];
      default:
        throw new RepoError("bad_request", `unknown query ${String(name)}`);
    }
  }

  farmSummary(): FarmSummary {
    const countWhere = (t: AnyTable, cond?: SQL) =>
      (
        this.db
          .select({ n: count() })
          .from(t)
          .where(and(isNull(t.deletedAt as SQLiteColumn), cond))
          .get() as { n: number }
      ).n;
    const since = new Date(this.now().getTime() - 7 * 86_400_000).toISOString();
    return {
      farm: this.farm(),
      counts: {
        cattle: countWhere(
          animals as unknown as AnyTable,
          and(eq(animals.species, "cattle"), eq(animals.status, "active")),
        ),
        horses: countWhere(
          animals as unknown as AnyTable,
          and(eq(animals.species, "horse"), eq(animals.status, "active")),
        ),
        devices: countWhere(devices as unknown as AnyTable),
        devicesOffline: countWhere(
          devices as unknown as AnyTable,
          inArray(devices.status, ["offline", "error"]),
        ),
        cameras: countWhere(cameras as unknown as AnyTable),
        camerasOnline: countWhere(cameras as unknown as AnyTable, eq(cameras.status, "online")),
        connectors: countWhere(connectors as unknown as AnyTable),
        connectorsWithErrors: countWhere(
          connectors as unknown as AnyTable,
          sql`${connectors.lastError} is not null`,
        ),
      },
      recentAlerts: this.db
        .select()
        .from(observations)
        .where(
          and(
            isNull(observations.deletedAt),
            inArray(observations.kind, [...ALERT_KINDS]),
            gte(observations.ts, since),
          ),
        )
        .orderBy(desc(observations.ts))
        .limit(50)
        .all(),
    };
  }

  private activeWearables(animalIds: string[]): Map<string, ActiveWearable> {
    const map = new Map<string, ActiveWearable>();
    if (animalIds.length === 0) return map;
    const rows = this.db
      .select({
        animalId: deviceBindings.animalId,
        deviceId: devices.id,
        kind: devices.kind,
        vendor: devices.vendor,
        batteryPct: devices.batteryPct,
      })
      .from(deviceBindings)
      .innerJoin(devices, eq(devices.id, deviceBindings.deviceId))
      .where(
        and(
          inArray(deviceBindings.animalId, animalIds),
          eq(deviceBindings.wearable, true),
          isNull(deviceBindings.unboundAt),
          isNull(deviceBindings.deletedAt),
        ),
      )
      .all();
    for (const r of rows) {
      map.set(r.animalId, {
        deviceId: r.deviceId,
        kind: r.kind as WearableKind,
        vendor: r.vendor,
        batteryPct: r.batteryPct,
      });
    }
    return map;
  }

  listAnimals(p: DbQueryParams<"animals.list">): DbQueryResults["animals.list"] {
    const conds: (SQL | undefined)[] = [isNull(animals.deletedAt)];
    if (p.species) conds.push(eq(animals.species, p.species));
    if (p.status) conds.push(eq(animals.status, p.status));
    if (p.groupName) conds.push(eq(animals.groupName, p.groupName));
    if (p.search) {
      const q = `%${p.search}%`;
      conds.push(
        or(like(animals.name, q), like(animals.earTagNumber, q), like(animals.nationalId, q)),
      );
    }
    const where = and(...conds);
    const total = (this.db.select({ n: count() }).from(animals).where(where).get() as { n: number })
      .n;
    const rows = this.db
      .select()
      .from(animals)
      .where(where)
      .orderBy(animals.species, animals.earTagNumber, animals.name)
      .limit(p.limit ?? 200)
      .offset(p.offset ?? 0)
      .all();
    const wearables = this.activeWearables(rows.map((r) => r.id));
    return { rows: rows.map((r) => ({ ...r, wearable: wearables.get(r.id) ?? null })), total };
  }

  getAnimal(id: string): DbQueryResults["animals.get"] {
    const animal = this.db
      .select()
      .from(animals)
      .where(and(eq(animals.id, id), isNull(animals.deletedAt)))
      .get();
    if (!animal) throw new RepoError("not_found", `animal ${id} not found`);
    const bindings = this.db
      .select()
      .from(deviceBindings)
      .where(and(eq(deviceBindings.animalId, id), isNull(deviceBindings.deletedAt)))
      .orderBy(desc(deviceBindings.boundAt))
      .all();
    const deviceIds = [...new Set(bindings.map((b) => b.deviceId))];
    return {
      animal,
      wearable: this.activeWearables([id]).get(id) ?? null,
      bindings,
      devices:
        deviceIds.length > 0
          ? this.db.select().from(devices).where(inArray(devices.id, deviceIds)).all()
          : [],
      recentObservations: this.recentObservations({ animalId: id, limit: 50 }),
    };
  }

  listDevices(kind?: DeviceKind): DbQueryResults["devices.list"] {
    const rows = this.db
      .select()
      .from(devices)
      .where(and(isNull(devices.deletedAt), kind ? eq(devices.kind, kind) : undefined))
      .orderBy(devices.kind, devices.serial)
      .all();
    const active = this.db
      .select({ deviceId: deviceBindings.deviceId, animalId: deviceBindings.animalId })
      .from(deviceBindings)
      .where(and(isNull(deviceBindings.unboundAt), isNull(deviceBindings.deletedAt)))
      .all();
    const bound = new Map(active.map((b) => [b.deviceId, b.animalId]));
    return { rows: rows.map((d) => ({ ...d, boundAnimalId: bound.get(d.id) ?? null })) };
  }

  listBindings(p: DbQueryParams<"bindings.list">): DbQueryResults["bindings.list"] {
    const rows = this.db
      .select({ binding: deviceBindings, deviceKind: devices.kind })
      .from(deviceBindings)
      .innerJoin(devices, eq(devices.id, deviceBindings.deviceId))
      .where(
        and(
          isNull(deviceBindings.deletedAt),
          p.animalId ? eq(deviceBindings.animalId, p.animalId) : undefined,
          p.deviceId ? eq(deviceBindings.deviceId, p.deviceId) : undefined,
          p.activeOnly === false ? undefined : isNull(deviceBindings.unboundAt),
        ),
      )
      .orderBy(desc(deviceBindings.boundAt))
      .all();
    return { rows: rows.map((r) => ({ ...r.binding, deviceKind: r.deviceKind })) };
  }

  listConnectors() {
    return this.db
      .select()
      .from(connectors)
      .where(isNull(connectors.deletedAt))
      .orderBy(connectors.vendor, connectors.name)
      .all();
  }

  getConnector(id: string) {
    const row = this.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.id, id), isNull(connectors.deletedAt)))
      .get();
    if (!row) throw new RepoError("not_found", `connector ${id} not found`);
    return row;
  }

  recentObservations(p: DbQueryParams<"observations.recent">): Observation[] {
    return this.db
      .select()
      .from(observations)
      .where(
        and(
          isNull(observations.deletedAt),
          p.animalId ? eq(observations.animalId, p.animalId) : undefined,
          p.kind ? eq(observations.kind, p.kind) : undefined,
          p.since ? gte(observations.ts, p.since) : undefined,
          p.alertsOnly ? inArray(observations.kind, [...ALERT_KINDS]) : undefined,
        ),
      )
      .orderBy(desc(observations.ts))
      .limit(p.limit ?? 100)
      .all();
  }

  // ------------------------------------------------------------------ mutations

  cameraLayout(): CameraMapLayout | null {
    const farm = this.farm();
    if (!farm) return null;
    const row = this.db
      .select()
      .from(cameraLayouts)
      .where(and(eq(cameraLayouts.farmId, farm.id), isNull(cameraLayouts.deletedAt)))
      .get();
    if (!row) return null;
    if (!Value.Check(CameraMapLayout, row.layout))
      throw new RepoError("bad_request", "invalid stored camera layout");
    return row.layout;
  }

  saveCameraLayout(layout: unknown, origin?: Partial<WriteOrigin>): DbMutateResult {
    if (!Value.Check(CameraMapLayout, layout))
      throw new RepoError("bad_request", "invalid camera layout");
    const farm = this.ensureFarm();
    const existing = this.db
      .select()
      .from(cameraLayouts)
      .where(and(eq(cameraLayouts.farmId, farm.id), isNull(cameraLayouts.deletedAt)))
      .get();
    // A stable farm UUID also makes independently created layouts converge through row LWW.
    const id = existing?.id ?? farm.id;
    const result = this.write(
      "camera_layouts",
      id,
      { layout, deletedAt: null },
      {
        description: "Saved camera layout",
        ...origin,
      },
    );
    return { ids: [id], snapshotId: result.snapshotId };
  }

  updateFarm(
    input: DbMutationParams<"farm.update">,
    origin?: Partial<WriteOrigin>,
  ): DbMutateResult {
    const farm = this.ensureFarm();
    const patch: Row = {};
    if (input.name !== undefined) {
      const trimmed = input.name.trim();
      if (!trimmed) throw new RepoError("bad_request", "farm name must not be empty");
      patch.name = trimmed;
    }
    if (input.timezone !== undefined) {
      const trimmed = input.timezone.trim();
      if (!trimmed) throw new RepoError("bad_request", "timezone must not be empty");
      patch.timezone = trimmed;
    }
    if (Object.keys(patch).length === 0) {
      return { ids: [farm.id], snapshotId: null };
    }
    const result = this.write("farms", farm.id, patch, {
      description: `Updated farm ${typeof patch.name === "string" ? patch.name : farm.name}`,
      ...origin,
    });
    return { ids: [farm.id], snapshotId: result.snapshotId };
  }

  upsertAnimal(input: AnimalInput, origin?: Partial<WriteOrigin>): DbMutateResult {
    const { id: givenId, ...fields } = input;
    const existing = givenId ? this.getRow("animals", givenId) : null;
    if (givenId && !existing)
      throw new RepoError("not_found", `animal ${givenId} not found; omit id to create`);
    const id = givenId ?? crypto.randomUUID();
    const label = fields.name ?? fields.earTagNumber ?? id.slice(0, 8);
    const r = this.write("animals", id, stripUndefined(fields), {
      description: `${existing ? "Updated" : "Added"} animal ${label}`,
      ...origin,
    });
    return { ids: [id], snapshotId: r.snapshotId };
  }

  upsertDevice(input: DeviceInput, origin?: Partial<WriteOrigin>): DbMutateResult {
    const { id: givenId, ...fields } = input;
    const existing = givenId ? this.getRow("devices", givenId) : null;
    if (givenId && !existing) throw new RepoError("not_found", `device ${givenId} not found`);
    const id = givenId ?? crypto.randomUUID();
    const r = this.write("devices", id, stripUndefined(fields), {
      description: `${existing ? "Updated" : "Added"} ${fields.kind} ${fields.serial ?? ""}`.trim(),
      ...origin,
    });
    return { ids: [id], snapshotId: r.snapshotId };
  }

  /** Returns the conflicting wearable, or null if binding is allowed (the one-wearable rule). */
  checkWearable(deviceId: string, animalId: string): WearableViolation | null {
    const device = this.getRow("devices", deviceId);
    if (!device || device.deletedAt)
      throw new RepoError("not_found", `device ${deviceId} not found`);
    const kind = device.kind as DeviceKind;
    if (!isWearableKind(kind)) return null;
    const conflict = this.db
      .select({ deviceId: deviceBindings.deviceId, kind: devices.kind })
      .from(deviceBindings)
      .innerJoin(devices, eq(devices.id, deviceBindings.deviceId))
      .where(
        and(
          eq(deviceBindings.animalId, animalId),
          eq(deviceBindings.wearable, true),
          isNull(deviceBindings.unboundAt),
          isNull(deviceBindings.deletedAt),
        ),
      )
      .all()
      .find((b) => b.deviceId !== deviceId);
    if (!conflict) return null;
    const animal = this.getRow("animals", animalId);
    return {
      animalId,
      animalName:
        (animal?.name as string | null) ?? (animal?.earTagNumber as string | null) ?? null,
      existingDeviceId: conflict.deviceId,
      existingKind: conflict.kind,
      requestedDeviceId: deviceId,
      requestedKind: kind,
    };
  }

  /**
   * Binds a device to an animal. Enforces the one-wearable rule (assertSingleWearable semantics:
   * throws rule_violation). A device already bound to another animal is moved: its old binding ends.
   */
  setBinding(deviceId: string, animalId: string, origin?: Partial<WriteOrigin>): DbMutateResult {
    const animal = this.getRow("animals", animalId);
    if (!animal || animal.deletedAt)
      throw new RepoError("not_found", `animal ${animalId} not found`);
    const violation = this.checkWearable(deviceId, animalId);
    if (violation) {
      const message = new SingleWearableError(
        animalId,
        violation.existingDeviceId,
        violation.existingKind,
      ).message;
      throw new RepoError("rule_violation", message, violation);
    }
    const device = this.getRow("devices", deviceId) as Row;
    const active = this.db
      .select()
      .from(deviceBindings)
      .where(
        and(
          eq(deviceBindings.deviceId, deviceId),
          isNull(deviceBindings.unboundAt),
          isNull(deviceBindings.deletedAt),
        ),
      )
      .get();
    if (active?.animalId === animalId) return { ids: [active.id], snapshotId: null };
    const id = crypto.randomUUID();
    try {
      const r = this.transact(
        {
          description: `Put ${device.kind} ${device.serial ?? ""} on ${animal.name ?? animal.earTagNumber ?? "animal"}`,
          ...origin,
        },
        (w) => {
          assertSingleWearable(this.db, { deviceId, animalId });
          if (active) w("device_bindings", active.id, { unboundAt: this.iso() });
          w("device_bindings", id, {
            deviceId,
            animalId,
            wearable: isWearableKind(device.kind as string),
            boundAt: this.iso(),
            unboundAt: null,
          });
        },
      );
      return { ids: [id], snapshotId: r.snapshotId };
    } catch (error) {
      if (error instanceof SingleWearableError || isUniqueViolation(error)) {
        throw new RepoError("rule_violation", "animal already wears an active wearable sensor");
      }
      throw error;
    }
  }

  clearBinding(deviceId: string, origin?: Partial<WriteOrigin>): DbMutateResult {
    const active = this.db
      .select()
      .from(deviceBindings)
      .where(
        and(
          eq(deviceBindings.deviceId, deviceId),
          isNull(deviceBindings.unboundAt),
          isNull(deviceBindings.deletedAt),
        ),
      )
      .get();
    if (!active) throw new RepoError("not_found", `device ${deviceId} has no active binding`);
    const r = this.write(
      "device_bindings",
      active.id,
      { unboundAt: this.iso() },
      { description: "Removed device from animal", ...origin },
    );
    return { ids: [active.id], snapshotId: r.snapshotId };
  }

  upsertConnector(
    input: Omit<ConnectorInput, "secret"> & { credentialRef?: string },
    origin?: Partial<WriteOrigin>,
    createId?: string,
  ): DbMutateResult {
    const { id: givenId, credentialRef, ...fields } = input;
    const existing = givenId ? (this.getRow("connectors", givenId) as Row | null) : null;
    if (givenId && !existing) throw new RepoError("not_found", `connector ${givenId} not found`);
    const id = givenId ?? createId ?? crypto.randomUUID();
    const config = {
      ...((existing?.config as JsonObject | undefined) ?? {}),
      ...(fields.config ?? {}),
      ...(credentialRef ? { credentialRef } : {}),
    };
    const r = this.write("connectors", id, stripUndefined({ ...fields, config }), {
      description: `${existing ? "Updated" : "Added"} connector ${fields.name ?? fields.vendor}`,
      ...origin,
    });
    return { ids: [id], snapshotId: r.snapshotId };
  }

  /**
   * Creates or patches animals a connector reported, in one transaction and without an undo
   * snapshot (like other connector imports). An animal is matched by national id, then ear tag.
   */
  importConnectorAnimals(rows: Array<Omit<AnimalInput, "id">>): {
    created: number;
    updated: number;
  } {
    let created = 0;
    let updated = 0;
    this.transact(null, (w) => {
      for (const row of rows) {
        const existing = this.matchAnimal(row.nationalId, row.earTagNumber);
        w("animals", existing?.id ?? crypto.randomUUID(), stripUndefined(row));
        if (existing) updated++;
        else created++;
      }
    });
    return { created, updated };
  }

  /** The live animal with this national id, else with this ear tag number. */
  matchAnimal(nationalId?: string | null, earTagNumber?: string | null): Animal | null {
    const live = isNull(animals.deletedAt);
    if (nationalId) {
      const byNational = this.db
        .select()
        .from(animals)
        .where(and(live, eq(animals.nationalId, nationalId)))
        .get();
      if (byNational) return byNational;
    }
    if (!earTagNumber) return null;
    return (
      this.db
        .select()
        .from(animals)
        .where(and(live, eq(animals.earTagNumber, earTagNumber)))
        .get() ?? null
    );
  }

  /** State a custom connector returned from its last successful run (local only, not synced). */
  getConnectorState(id: string): unknown {
    return (
      this.db
        .select()
        .from(syncState)
        .where(eq(syncState.key, `connector-state:${id}`))
        .get()?.value ?? null
    );
  }

  setConnectorState(id: string, value: unknown) {
    const row = { key: `connector-state:${id}`, value, updatedAt: this.iso() };
    this.db
      .insert(syncState)
      .values(row)
      .onConflictDoUpdate({ target: syncState.key, set: { value, updatedAt: row.updatedAt } })
      .run();
  }

  /** Connector sync bookkeeping; not undoable (no snapshot). */
  recordConnectorSync(id: string, error: string | null) {
    this.transact(null, (w) =>
      w("connectors", id, {
        lastError: error,
        ...(error ? {} : { lastSyncAt: this.iso() }),
      }),
    );
  }

  addObservation(
    input: DbMutationParams<"observations.add">,
    origin?: Partial<WriteOrigin>,
  ): DbMutateResult {
    if (input.animalId) this.getAnimal(input.animalId);
    const id = crypto.randomUUID();
    const result = this.write(
      "observations",
      id,
      {
        animalId: input.animalId ?? null,
        deviceId: null,
        source: "orion",
        kind: input.kind,
        ts: input.ts,
        valueNum: input.valueNum ?? null,
        valueJson: input.valueJson ?? null,
      },
      { ...origin, description: "Added observation" },
    );
    return { ids: [id], snapshotId: result.snapshotId };
  }

  insertObservations(
    rows: Array<
      Omit<
        Observation,
        "farmId" | "createdAt" | "updatedAt" | "deletedAt" | "hlc" | "originDevice" | "id"
      > & { id?: string }
    >,
  ): string[] {
    const ids: string[] = [];
    this.transact(null, (w) => {
      for (const row of rows) {
        const { id: given, ...rest } = row;
        const id = given ?? crypto.randomUUID();
        w("observations", id, rest);
        ids.push(id);
      }
    });
    return ids;
  }

  upsertCamera(
    input: Omit<CameraInput, "password" | "username"> & { credentialRef?: string | null },
    origin?: Partial<WriteOrigin>,
    createId?: string,
  ): DbMutateResult {
    const { id: givenId, ...fields } = input;
    const existing = givenId ? this.getRow("cameras", givenId) : null;
    if (givenId && !existing) throw new RepoError("not_found", `camera ${givenId} not found`);
    const id = givenId ?? createId ?? crypto.randomUUID();
    const r = this.write("cameras", id, stripUndefined(fields), {
      description: `${existing ? "Updated" : "Added"} camera ${fields.name}`,
      ...origin,
    });
    return { ids: [id], snapshotId: r.snapshotId };
  }

  // ------------------------------------------------------------------ snapshots

  /** Records a workspace (git) snapshot so it shows up in snapshots.list next to database writes. */
  recordWorkspaceSnapshot(input: {
    commit: string;
    parent: string;
    files: string[];
    sessionId: string | null;
    description: string;
  }): string {
    const id = crypto.randomUUID();
    this.db
      .insert(snapshots)
      .values({
        id,
        sessionId: input.sessionId,
        toolCallId: null,
        description: input.description,
        changes: [
          {
            table: "workspace",
            rowId: input.commit,
            before: { commit: input.parent },
            after: { commit: input.commit, files: input.files },
          },
        ],
        createdAt: this.iso(),
      })
      .run();
    return id;
  }

  listSnapshots(sessionId?: string, limit = 100): SnapshotSummary[] {
    return this.db
      .select()
      .from(snapshots)
      .where(sessionId ? eq(snapshots.sessionId, sessionId) : undefined)
      .orderBy(desc(snapshots.createdAt), desc(sql`rowid`))
      .limit(limit)
      .all()
      .map(toSummary);
  }

  getSnapshot(id: string) {
    const row = this.db.select().from(snapshots).where(eq(snapshots.id, id)).get();
    if (!row) throw new RepoError("not_found", `snapshot ${id} not found`);
    return row;
  }

  /** Reverts the database rows of a snapshot (restores `before`, soft-deletes inserted rows). */
  undoDbSnapshot(id: string): {
    snapshot: SnapshotSummary;
    restored: { table: string; ids: string[] }[];
  } {
    const snap = this.getSnapshot(id);
    if (snap.undoneAt) throw new RepoError("conflict", "this change was already undone");
    const restored = new Map<string, string[]>();
    try {
      this.transact(null, (w) => {
        for (const change of [...snap.changes].reverse()) {
          if (change.table === "workspace") continue;
          const name = change.table as SyncedTableName;
          if (change.before === null) {
            w(name, change.rowId, { deletedAt: this.iso() });
          } else {
            const {
              id: _id,
              farmId: _f,
              createdAt: _c,
              updatedAt: _u,
              hlc: _h,
              originDevice: _o,
              ...fields
            } = change.before as Row;
            w(name, change.rowId, fields);
          }
          restored.set(name, [...(restored.get(name) ?? []), change.rowId]);
        }
        this.db.update(snapshots).set({ undoneAt: this.iso() }).where(eq(snapshots.id, id)).run();
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RepoError(
          "conflict",
          "cannot undo: a later change conflicts (for example the animal now wears another sensor)",
        );
      }
      throw error;
    }
    return {
      snapshot: toSummary(this.getSnapshot(id)),
      restored: [...restored].map(([table, ids]) => ({ table, ids })),
    };
  }

  markSnapshotUndone(id: string) {
    this.db.update(snapshots).set({ undoneAt: this.iso() }).where(eq(snapshots.id, id)).run();
    return toSummary(this.getSnapshot(id));
  }

  pendingOutbox(): number {
    return (
      this.db.select({ n: count() }).from(outbox).where(isNull(outbox.ackedAt)).get() as {
        n: number;
      }
    ).n;
  }

  findAnimal(ref: string): Animal | null {
    return (
      this.db
        .select()
        .from(animals)
        .where(
          and(
            isNull(animals.deletedAt),
            or(eq(animals.id, ref), eq(animals.earTagNumber, ref), eq(animals.name, ref)),
          ),
        )
        .get() ?? null
    );
  }
}

function stripUndefined<T extends object>(obj: T): Row {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function toSummary(row: typeof snapshots.$inferSelect): SnapshotSummary {
  const tables = [...new Set(row.changes.map((c) => c.table))];
  const rowCount = row.changes.reduce((n, c) => {
    const files = (c.after as { files?: unknown[] } | null)?.files;
    return n + (c.table === "workspace" && Array.isArray(files) ? files.length : 1);
  }, 0);
  return {
    id: row.id,
    createdAt: row.createdAt,
    description: row.description,
    sessionId: row.sessionId,
    toolCallId: row.toolCallId,
    tables,
    rowCount,
    undoneAt: row.undoneAt,
  };
}
