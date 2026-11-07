import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CameraMapLayout } from "@orbit/protocol";
import { cameraLayouts, outbox } from "@orbit/schema";
import { eq } from "drizzle-orm";
import { openDatabase } from "../src/db/open";
import { EncryptedFileStore } from "../src/secrets";
import { Go2rtcRelay, resolveRelayBinary } from "../src/services/relay";
import { connect, removeDir, startApp, TOKEN, tempDir, waitFor } from "./helpers";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const layout = {
  version: 2,
  tiles: [{ i: "barn", x: -30, y: 20, w: 400, ar: 16 / 9 }],
} satisfies CameraMapLayout;

test("camera layout writes keep one row with outbox, snapshot and change notifications", () => {
  const dir = tempDir();
  cleanups.push(() => removeDir(dir));
  const db = openDatabase(dir, { seed: true });
  cleanups.push(() => db.close());
  const changed: string[] = [];
  db.repo.onChange((table) => changed.push(table));
  expect(db.repo.query("cameraLayout.get", {})).toEqual({ layout: null });

  const saved = db.repo.saveCameraLayout(layout);
  db.repo.saveCameraLayout({ version: 2, tiles: [] });

  expect(db.repo.query("cameraLayout.get", {})).toEqual({ layout: { version: 2, tiles: [] } });
  expect(db.repo.db.select().from(cameraLayouts).all()).toHaveLength(1);
  const queued = db.repo.db.select().from(outbox).where(eq(outbox.table, "camera_layouts")).all();
  expect(queued.map((row) => row.op)).toEqual(["insert", "update"]);
  expect(queued[0]?.payload.layout).toEqual(layout);
  expect(queued[0]?.rowId).toBe(db.repo.farm()?.id);
  expect(queued[0]?.hlc).toBeString();
  expect(changed).toEqual(["camera_layouts", "camera_layouts"]);
  if (!saved.snapshotId) throw new TypeError("missing snapshot");
  expect(db.repo.getSnapshot(saved.snapshotId).changes[0]).toMatchObject({
    table: "camera_layouts",
    before: null,
    after: { layout },
  });
});

test("malformed camera layouts are rejected without queuing a write", () => {
  const dir = tempDir();
  cleanups.push(() => removeDir(dir));
  const db = openDatabase(dir, { seed: true });
  cleanups.push(() => db.close());

  expect(() => db.repo.saveCameraLayout({ version: 2, tiles: [{ i: "barn", w: -1 }] })).toThrow(
    "invalid camera layout",
  );

  expect(db.repo.query("cameraLayout.get", {})).toEqual({ layout: null });
  expect(db.repo.db.select().from(outbox).all()).toEqual([]);
});

test("camera layout save and get round trip over the protocol and emit camera_layouts", async () => {
  const dir = tempDir();
  cleanups.push(() => removeDir(dir));
  const app = await startApp(dir);
  cleanups.push(() => app.stop());
  const client = await connect(app);
  cleanups.push(() => client.close());
  const changed = waitFor(client, "db.changed", (event) => event.table === "camera_layouts");

  await client.mutate("cameraLayout.save", { layout });

  const farmId = client.server?.farmId;
  if (!farmId) throw new TypeError("missing farm");
  expect((await changed).ids).toEqual([farmId]);
  expect(await client.query("cameraLayout.get", {})).toEqual({ layout });
});

test("go2rtc binary resolution uses override, sibling, data directory, then PATH", () => {
  const dir = tempDir();
  cleanups.push(() => removeDir(dir));
  const name = process.platform === "win32" ? "go2rtc.exe" : "go2rtc";
  const execPath = join(dir, "sidecars", "orion");
  const candidates = [
    join(dir, "override"),
    join(dirname(execPath), name),
    join(dir, "bin", name),
    join(dir, "path", name),
  ];
  const env = { ORION_GO2RTC_BIN: candidates[0], PATH: join(dir, "path") };
  expect(resolveRelayBinary(dir, env, execPath)).toBeNull();
  for (const candidate of [...candidates].reverse()) {
    mkdirSync(dirname(candidate), { recursive: true });
    writeFileSync(candidate, "");
    chmodSync(candidate, 0o755);
    expect(resolveRelayBinary(dir, env, execPath)).toBe(candidate);
  }
});

test("an absent relay reports unavailable while authenticated camera routes return 503", async () => {
  const dir = tempDir();
  cleanups.push(() => removeDir(dir));
  const prior = process.env.ORION_GO2RTC_BIN;
  process.env.ORION_GO2RTC_BIN = join(dir, "missing");
  cleanups.push(() => {
    if (prior === undefined) delete process.env.ORION_GO2RTC_BIN;
    else process.env.ORION_GO2RTC_BIN = prior;
  });
  const db = openDatabase(dir, { seed: true });
  cleanups.push(() => db.close());
  const relay = new Go2rtcRelay(db.repo, new EncryptedFileStore(dir), dir);
  await relay.start();
  cleanups.push(() => relay.stop());
  expect(relay.status()).toEqual({ available: false, reason: "go2rtc binary not found" });
  const app = await startApp(dir);
  cleanups.push(() => app.stop());
  const client = await connect(app);
  cleanups.push(() => client.close());

  expect(await client.query("cameras.relay", {})).toEqual(relay.status());
  for (const endpoint of ["frame.jpeg", "ws"]) {
    expect((await fetch(`http://127.0.0.1:${app.port}/camera/wrong/barn/${endpoint}`)).status).toBe(
      401,
    );
    expect(
      (await fetch(`http://127.0.0.1:${app.port}/camera/${TOKEN}/barn/${endpoint}`)).status,
    ).toBe(503);
  }
});
