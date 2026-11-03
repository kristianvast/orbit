import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { animals, deviceBindings, devices, outbox } from "@orbit/schema";
import type { LocalDb } from "@orbit/schema/local";
import { eq } from "drizzle-orm";
import { createSyncEngine, type FetchLike, type SyncEngine, type SyncStatus } from "../src";
import { FARM, FakeCore, freshDb, hlcAt, pgAnimal, TOKEN } from "./fake-core";

const A1 = "00000000-0000-4000-8000-0000000000a1";
const A2 = "00000000-0000-4000-8000-0000000000a2";

let core: FakeCore;
let db: LocalDb;
const engines: SyncEngine[] = [];

beforeEach(() => {
  core = new FakeCore();
  db = freshDb();
});
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  core.stop();
});

function engine(extra: { fetch?: FetchLike; batchSize?: number } = {}) {
  const e = createSyncEngine({
    db,
    farmId: FARM,
    coreUrl: core.url,
    token: TOKEN,
    nodeId: "local",
    intervalMs: 60_000,
    retry: { baseMs: 1, maxMs: 5, jitter: 0 },
    ...extra,
  });
  engines.push(e);
  return e;
}

function waitForStatus(e: SyncEngine, pred: (s: SyncStatus) => boolean, ms = 3000) {
  return new Promise<SyncStatus>((resolve, reject) => {
    const timeout = setTimeout(() => {
      off();
      reject(new Error(`timed out; last status ${JSON.stringify(e.status())}`));
    }, ms);
    const off = e.on("status", (s) => {
      if (!pred(s)) return;
      clearTimeout(timeout);
      off();
      resolve(s);
    });
  });
}

function localAnimal(id: string, hlc: string, name = "Local name") {
  db.insert(animals)
    .values({
      id,
      species: "cattle",
      name,
      farmId: FARM,
      createdAt: "2026-11-01T08:00:00.000Z",
      updatedAt: "2026-11-01T08:00:00.000Z",
      hlc,
      originDevice: "local",
    })
    .run();
}

function queue(op: "insert" | "update" | "delete", rowId: string, hlc: string, payload: object) {
  db.insert(outbox)
    .values({
      op,
      table: "animals",
      rowId,
      hlc,
      payload: payload as Record<string, unknown>,
      createdAt: "2026-11-03T00:00:00.000Z",
    })
    .run();
}

const getAnimal = (id: string) => db.select().from(animals).where(eq(animals.id, id)).get();

describe("pull", () => {
  test("applies shape rows, normalising Postgres values, and resumes from the stored offset", async () => {
    core.emit("animals", pgAnimal(A1, hlcAt("2026-11-02T00:00:00Z")));
    core.emit("devices", {
      id: "00000000-0000-4000-8000-0000000000d1",
      kind: "collar",
      vendor: "cowmanager",
      model: null,
      serial: "C-1",
      connection: '{"host":"10.0.0.5"}',
      status: "online",
      battery_pct: "87.5",
      last_seen_at: "2026-11-02 09:30:00+01",
      farm_id: FARM,
      created_at: "2026-11-01 08:00:00+00",
      updated_at: "2026-11-01 08:00:00+00",
      deleted_at: null,
      hlc: hlcAt("2026-11-02T00:00:00Z"),
      origin_device: "cloud",
    });
    const e = engine();
    const changed: string[] = [];
    e.on("changes", (c) => changed.push(`${c.table}:${c.ids.join(",")}`));

    const result = await e.syncNow();

    expect(result).toMatchObject({ ok: true, pulled: 2 });
    expect(changed).toEqual([`animals:${A1}`, "devices:00000000-0000-4000-8000-0000000000d1"]);
    expect(getAnimal(A1)).toMatchObject({
      name: "Dagros",
      birthDate: "2022-03-01",
      updatedAt: "2026-11-01T08:00:00.123Z",
    });
    const device = db.select().from(devices).get();
    expect(device).toMatchObject({
      batteryPct: 87.5,
      connection: { host: "10.0.0.5" },
      lastSeenAt: "2026-11-02T08:30:00.000Z",
    });
    expect(e.status()).toMatchObject({ state: "up_to_date", pendingOutbox: 0 });

    core.emit("animals", pgAnimal(A2, hlcAt("2026-11-02T00:00:01Z"), { name: "Rosa" }));
    const before = core.shapeRequests.length;
    await e.syncNow();
    const animalReq = core.shapeRequests.slice(before).find((p) => p.get("table") === "animals");
    expect(animalReq?.get("offset")).toBe("1_0");
    expect(animalReq?.get("handle")).toBe("handle-1");
    expect(getAnimal(A2)?.name).toBe("Rosa");
  });

  test("409 must-refetch restarts the shape from offset -1 with the new handle", async () => {
    core.emit("animals", pgAnimal(A1, hlcAt("2026-11-02T00:00:00Z")));
    const e = engine();
    await e.syncNow();
    let refetched = false;
    core.shapeResponder = (p) => {
      if (refetched || p.get("table") !== "animals") return undefined;
      refetched = true;
      core.handle = "handle-2";
      return new Response("[]", { status: 409, headers: { "electric-handle": "handle-2" } });
    };
    const before = core.shapeRequests.length;
    expect((await e.syncNow()).ok).toBe(true);
    const animalReqs = core.shapeRequests.slice(before).filter((p) => p.get("table") === "animals");
    expect(animalReqs.map((p) => [p.get("offset"), p.get("handle")])).toEqual([
      ["1_0", "handle-1"],
      ["-1", "handle-2"],
    ]);
  });
});

describe("last-writer-wins", () => {
  test("a newer incoming row overwrites an older local row", async () => {
    localAnimal(A1, hlcAt("2026-11-01T00:00:00Z", 0, "local"));
    core.emit("animals", pgAnimal(A1, hlcAt("2026-11-02T00:00:00Z"), { name: "Cloud name" }));
    await engine().syncNow();
    expect(getAnimal(A1)).toMatchObject({ name: "Cloud name", originDevice: "cloud" });
  });

  test("an older incoming row never overwrites a newer local row", async () => {
    const localHlc = hlcAt("2026-11-02T00:00:00Z", 0, "local");
    localAnimal(A1, localHlc);
    core.emit("animals", pgAnimal(A1, hlcAt("2026-11-01T00:00:00Z"), { name: "Cloud name" }));
    const result = await engine().syncNow();
    expect(result.pulled).toBe(0);
    expect(getAnimal(A1)).toMatchObject({ name: "Local name", hlc: localHlc });
  });
});

describe("outbox push", () => {
  test("pushes in seq-ordered batches and acknowledges every row", async () => {
    for (let i = 0; i < 5; i++) {
      const hlc = hlcAt("2026-11-03T00:00:00Z", i, "local");
      queue("insert", A1, hlc, { id: A1, farmId: FARM, name: `v${i}`, hlc });
    }
    const result = await engine({ batchSize: 2 }).syncNow();
    expect(result).toMatchObject({ ok: true, pushed: 5 });
    expect(core.pushes.map((b) => b.map((c) => c.seq))).toEqual([[1, 2], [3, 4], [5]]);
    expect(core.pushes[0]?.[0]?.row).toMatchObject({ id: A1, farm_id: FARM, name: "v0" });
    expect(
      db
        .select()
        .from(outbox)
        .all()
        .every((r) => r.ackedAt !== null),
    ).toBe(true);
  });

  test("retries with backoff after a 500 and then marks rows acknowledged", async () => {
    queue("update", A1, hlcAt("2026-11-03T00:00:00Z", 0, "local"), { id: A1, farm_id: FARM });
    let calls = 0;
    core.pushResponder = (changes) => {
      calls++;
      if (calls === 1) return new Response("boom", { status: 500 });
      return changes.map((c) => ({ seq: c.seq, status: "applied" as const }));
    };
    const e = engine();
    const sawOffline = waitForStatus(e, (s) => s.state === "offline");
    const done = waitForStatus(e, (s) => s.state === "up_to_date" && s.pendingOutbox === 0);
    e.start();
    expect((await sawOffline).pendingOutbox).toBe(1);
    await done;
    expect(calls).toBe(2);
    const row = db.select().from(outbox).get();
    expect(row).toMatchObject({ attempts: 1, lastError: null });
    expect(row?.ackedAt).not.toBeNull();
  });

  test("keeps the outbox intact while Core is unreachable", async () => {
    queue("insert", A1, hlcAt("2026-11-03T00:00:00Z", 0, "local"), { id: A1, farm_id: FARM });
    let online = false;
    const e = engine({
      fetch: (input, init) =>
        online ? fetch(input, init) : Promise.reject(new TypeError("connection refused")),
    });
    const offline = await e.syncNow();
    expect(offline.ok).toBe(false);
    expect(e.status()).toMatchObject({ state: "offline", pendingOutbox: 1 });
    expect(db.select().from(outbox).get()).toMatchObject({ ackedAt: null, attempts: 1 });
    online = true;
    expect((await e.syncNow()).ok).toBe(true);
    expect(e.status().pendingOutbox).toBe(0);
  });

  test("conflict results stay pending; rejected results are settled with the error", async () => {
    queue("insert", A1, hlcAt("2026-11-03T00:00:00Z", 0, "local"), { id: A1, farm_id: FARM });
    queue("insert", A2, hlcAt("2026-11-03T00:00:00Z", 1, "local"), { id: A2, farm_id: FARM });
    core.pushResponder = ([a, b]) => [
      { seq: a?.seq ?? 0, status: "conflict", error: "unique" },
      { seq: b?.seq ?? 0, status: "rejected", error: "bad species" },
    ];
    await engine().syncNow();
    const [first, second] = db.select().from(outbox).orderBy(outbox.seq).all();
    expect(first).toMatchObject({ ackedAt: null, attempts: 1 });
    expect(second?.ackedAt).not.toBeNull();
    expect(second?.lastError).toBe("rejected: bad species");
  });
});

describe("soft deletes", () => {
  test("an incoming soft delete keeps the row and sets deleted_at", async () => {
    localAnimal(A1, hlcAt("2026-11-01T00:00:00Z", 0, "local"));
    core.emit(
      "animals",
      pgAnimal(A1, hlcAt("2026-11-02T00:00:00Z"), { deleted_at: "2026-11-02 12:00:00+00" }),
    );
    await engine().syncNow();
    expect(getAnimal(A1)?.deletedAt).toBe("2026-11-02T12:00:00.000Z");
  });

  test("a local soft delete is pushed as a delete op carrying deleted_at", async () => {
    const hlc = hlcAt("2026-11-03T00:00:00Z", 0, "local");
    queue("delete", A1, hlc, { id: A1, farmId: FARM, deletedAt: "2026-11-03T00:00:00.000Z", hlc });
    await engine().syncNow();
    expect(core.pushes[0]?.[0]).toMatchObject({
      op: "delete",
      row: { id: A1, deleted_at: "2026-11-03T00:00:00.000Z" },
    });
  });
});

describe("single active wearable", () => {
  const COW = "00000000-0000-4000-8000-0000000000c1";
  const BOLUS = "00000000-0000-4000-8000-0000000000d1";
  const COLLAR = "00000000-0000-4000-8000-0000000000d2";
  const B_LOCAL = "00000000-0000-4000-8000-0000000000b1";
  const B_CLOUD = "00000000-0000-4000-8000-0000000000b2";

  function localBolusBinding(hlc: string) {
    db.insert(deviceBindings)
      .values({
        id: B_LOCAL,
        deviceId: BOLUS,
        animalId: COW,
        wearable: true,
        boundAt: "2026-11-01T00:00:00.000Z",
        farmId: FARM,
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        hlc,
        originDevice: "local",
      })
      .run();
  }
  function cloudCollarBinding(hlc: string) {
    core.emit("device_bindings", {
      id: B_CLOUD,
      device_id: COLLAR,
      animal_id: COW,
      wearable: "t",
      bound_at: "2026-11-02 00:00:00+00",
      unbound_at: null,
      farm_id: FARM,
      created_at: "2026-11-02 00:00:00+00",
      updated_at: "2026-11-02 00:00:00+00",
      deleted_at: null,
      hlc,
      origin_device: "cloud",
    });
  }
  const binding = (id: string) =>
    db.select().from(deviceBindings).where(eq(deviceBindings.id, id)).get();
  const queued = () => db.select().from(outbox).all();

  test("a newer incoming collar binding ends the older local bolus binding", async () => {
    localBolusBinding(hlcAt("2026-11-01T00:00:00Z", 0, "local"));
    cloudCollarBinding(hlcAt("2026-11-02T00:00:00Z"));
    core.pushResponder = () => new Response("down", { status: 503 });
    await engine().syncNow();
    expect(binding(B_CLOUD)?.unboundAt).toBeNull();
    expect(binding(B_LOCAL)?.unboundAt).toBe("2026-11-02T00:00:00.000Z");
    expect(queued()).toMatchObject([
      { op: "update", table: "device_bindings", rowId: B_LOCAL, ackedAt: null },
    ]);
  });

  test("an older incoming binding is stored already ended when the local one is newer", async () => {
    localBolusBinding(hlcAt("2026-11-03T00:00:00Z", 0, "local"));
    cloudCollarBinding(hlcAt("2026-11-02T00:00:00Z"));
    core.pushResponder = () => new Response("down", { status: 503 });
    await engine().syncNow();
    expect(binding(B_LOCAL)?.unboundAt).toBeNull();
    expect(binding(B_CLOUD)?.unboundAt).toBe("2026-11-01T00:00:00.000Z");
    expect(queued()).toMatchObject([{ rowId: B_CLOUD, ackedAt: null }]);
  });
});
