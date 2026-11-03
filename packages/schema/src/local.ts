// Bun-only helpers for the local database. Not browser-safe (imports bun:sqlite).
import { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteMigrations } from "./migrations.gen";
import { sqliteSchema } from "./sqlite";

export type LocalDb = BunSQLiteDatabase<typeof sqliteSchema> & { $client: Database };

/** Opens (or creates) the local Orbit database. Use ":memory:" for tests. Does not migrate. */
export function openLocalDb(path = ":memory:"): LocalDb {
  const client = new Database(path, { create: true, strict: true });
  client.exec("PRAGMA journal_mode = WAL;");
  client.exec("PRAGMA busy_timeout = 5000;");
  return drizzle({ client, schema: sqliteSchema }) as LocalDb;
}

export interface MigrateResult {
  applied: string[];
}

/**
 * Applies the drizzle-kit SQLite migrations (embedded in migrations.gen.ts so this also works in a
 * compiled sidecar binary). Idempotent; applied tags are tracked in __orbit_migrations.
 */
// biome-ignore lint/suspicious/noExplicitAny: works with any bun:sqlite drizzle database
export function migrate(db: BunSQLiteDatabase<any> & { $client: Database }): MigrateResult {
  const client = db.$client;
  client.exec(
    "CREATE TABLE IF NOT EXISTS __orbit_migrations (tag TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const done = new Set(
    client
      .query<{ tag: string }, []>("SELECT tag FROM __orbit_migrations")
      .all()
      .map((r) => r.tag),
  );
  const applied: string[] = [];
  const run = client.transaction(() => {
    for (const m of sqliteMigrations) {
      if (done.has(m.tag)) continue;
      for (const statement of m.statements) {
        if (statement.trim()) client.exec(statement);
      }
      client
        .query("INSERT INTO __orbit_migrations (tag, applied_at) VALUES (?, ?)")
        .run(m.tag, new Date().toISOString());
      applied.push(m.tag);
    }
  });
  run();
  db.run(sql`PRAGMA optimize`);
  return { applied };
}
