import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { animals, farms } from "@orbit/schema";
import { migrate, openLocalDb } from "@orbit/schema/local";
import { seedDemoFarm } from "@orbit/schema/seed";
import { count } from "drizzle-orm";
import { Repository } from "./repo";

export interface OpenedDb {
  repo: Repository;
  seeded: boolean;
  close(): void;
}

/** Stable per-install node id (used as HLC node and origin_device). No ':' allowed. */
export function readInstallId(dataDir: string): string {
  const file = join(dataDir, "install-id");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const id = `orbit-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  writeFileSync(file, id);
  return id;
}

export function openDatabase(dataDir: string, options: { seed: boolean }): OpenedDb {
  mkdirSync(dataDir, { recursive: true });
  const db = openLocalDb(join(dataDir, "orbit.sqlite"));
  migrate(db);
  const repo = new Repository(db, readInstallId(dataDir));
  let seeded = false;
  if (options.seed) {
    const empty =
      (db.select({ n: count() }).from(farms).get()?.n ?? 0) === 0 &&
      (db.select({ n: count() }).from(animals).get()?.n ?? 0) === 0;
    if (empty) seeded = seedDemoFarm(db).created;
  }
  // close(true) finalizes cached statements and closes now; the default defers the close and
  // keeps orbit.sqlite (+ -wal/-shm) open, which locks the data folder on Windows.
  return { repo, seeded, close: () => db.$client.close(true) };
}
