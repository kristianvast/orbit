import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CoreDb, coreSchema, createApp, createLogMailer, migrate } from "@core/api";
import { PGlite } from "@electric-sql/pglite";
import type { OrionClient } from "@orbit/protocol/client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { MOCK_MODEL, MOCK_PROVIDER } from "../src/agent/mock-model";
import { type OrionApp, startOrion } from "../src/app";
import { farmDir } from "../src/services/farm-folders";
import { connect, removeDir, TOKEN, tempDir, waitFor } from "./helpers";

process.env.ORION_NO_BROWSER = "1";
const PASSWORD = "correct horse battery";
let pg: PGlite;
let db: CoreDb;
let core: ReturnType<typeof Bun.serve>;
let onPush: (() => void) | null = null;
const pcs: { app: OrionApp; client: OrionClient; dir: string }[] = [];

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle({ client: pg, schema: coreSchema }) as unknown as CoreDb;
  await migrate(db);
  const app = createApp({
    db,
    resolveToken: async () => null,
    electricUrl: "http://electric.test",
    mailer: createLogMailer(() => {}),
    fetch: async () =>
      Response.json([{ headers: { control: "up-to-date" } }], {
        headers: { "electric-handle": "h1", "electric-offset": "0_0", "electric-up-to-date": "" },
      }),
  });
  core = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const response = await app.fetch(request);
      if (new URL(request.url).pathname === "/v1/farm-code/commits" && response.ok) onPush?.();
      return response;
    },
  });
}, 60_000);
afterAll(async () => {
  core.stop(true);
  await pg.close();
});
beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE farm_code_heads, farm_code_commits, farm_code_blobs, farms, users, farm_members, user_sessions, login_failures, email_tokens CASCADE`,
  );
});
afterEach(async () => {
  onPush = null;
  for (const pc of pcs.splice(0)) {
    pc.client.close();
    await pc.app.stop();
    removeDir(pc.dir);
  }
});
type Pc = { app: OrionApp; client: OrionClient; dir: string; reopened: PromiseWithResolvers<void> };
async function boot(dir = tempDir()): Promise<Pc> {
  const reopened = Promise.withResolvers<void>();
  const app = await startOrion({
    dataDir: dir,
    port: 0,
    token: TOKEN,
    seed: false,
    mockModel: true,
    appSource: null,
    gatewayUrl: null,
    coreUrl: `http://127.0.0.1:${core.port}`,
    reopen: () => reopened.resolve(),
  });
  const pc = { dir, app, client: await connect(app), reopened };
  pcs.push(pc);
  return pc;
}
/** The open farm's workspace: this PC's own farm, or farms/<id>/ for a farm opened from the cloud. */
function workspacePath(pc: { dir: string }, path: string): string {
  return join(farmDir(pc.dir), "workspace", path);
}
function file(pc: { dir: string }, path: string, content: string): void {
  const target = workspacePath(pc, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
}
function text(pc: { dir: string }, path: string): string {
  return readFileSync(workspacePath(pc, path), "utf8");
}
/** The first PC puts its farm in the cloud; the second signs in and opens that farm (a restart). */
async function pair(prepare: (first: Pc) => void = () => {}) {
  const first = await boot();
  prepare(first);
  await first.client.request("account.register", {
    email: "farm@test.example",
    password: PASSWORD,
    acceptTerms: true,
  });
  const { farm } = await first.client.request("farms.create", {});
  if (!farm) throw new Error("farms.create linked no farm");
  const joining = await boot();
  await joining.client.request("account.login", { email: "farm@test.example", password: PASSWORD });
  expect(await joining.client.request("farms.open", { farmId: farm.id })).toEqual({
    restarting: true,
  });
  await joining.reopened.promise;
  pcs.splice(pcs.indexOf(joining), 1);
  joining.client.close();
  await joining.app.stop();
  const second = await boot(joining.dir);
  return { first, second, farm };
}

test("an agent workspace commit pushes immediately and another Orion can pull it", async () => {
  const { first, second } = await pair();
  await first.client.request("settings.update", { provider: MOCK_PROVIDER, model: MOCK_MODEL });
  const { session } = await first.client.request("sessions.create", {});
  const pushed = Promise.withResolvers<void>();
  onPush = () => pushed.resolve();
  const settled = waitFor(first.client, "agent.settled", (event) => event.sessionId === session.id);
  await first.client.request("chat.prompt", { sessionId: session.id, text: "Write a note" });
  expect((await settled).reason).toBe("completed");
  await pushed.promise;
  await second.client.request("account.refresh", {});
  expect(text(second, "notes/orion-note.md")).toBe(
    "# Note from Orion\n\nWritten by the mock model.\n",
  );
}, 30_000);

test("a fresh signed-in Orion adopts farm code and both PCs merge independent edits with undo", async () => {
  const { first, second, farm } = await pair((pc) => {
    file(pc, "pages/morning/index.html", "<h1>Farm morning</h1>");
    file(pc, "memory/farm.md", "The barn has two gates.");
    file(pc, ".env", "DO_NOT_SEND=true");
    file(pc, "secrets.json", '{"private":"never send"}');
    file(pc, "scripts/private.ts", 'const api_key = "private-value-123456";');
    file(pc, "node_modules/generated.js", "not shared");
  });
  expect(text(second, "pages/morning/index.html")).toBe("<h1>Farm morning</h1>");
  expect(text(second, "memory/farm.md")).toBe("The barn has two gates.");
  expect((await second.client.request("pages.list", {})).pages.map((p) => p.id)).toContain(
    "morning",
  );
  for (const path of [".env", "secrets.json", "scripts/private.ts", "node_modules/generated.js"])
    expect(existsSync(workspacePath(second, path))).toBe(false);
  const { snapshots } = await second.client.request("snapshots.list", {});
  const pulled = snapshots.find((s) => s.description === "Farm code synchronized");
  expect(pulled).toBeDefined();
  if (!pulled) throw new Error("Missing pulled workspace snapshot");
  await second.client.request("snapshots.undo", { snapshotId: pulled.id });
  expect(existsSync(workspacePath(second, "pages/morning/index.html"))).toBe(false);
  // Recreate the undone page and then independently edit two different files.
  file(second, "pages/morning/index.html", "<h1>Farm morning</h1>");
  file(first, "scripts/first.sh", "echo first\n");
  file(second, "scripts/second.sh", "echo second\n");
  await first.client.request("account.refresh", {});
  await second.client.request("account.refresh", {});
  await first.client.request("account.refresh", {});
  expect(text(first, "scripts/second.sh")).toBe("echo second\n");
  expect(text(second, "scripts/first.sh")).toBe("echo first\n");
  const state = () =>
    JSON.parse(readFileSync(join(farmDir(first.dir), "farm-code", farm.id, "base.json"), "utf8"));
  const head = state().head.id;
  await first.client.request("account.refresh", {});
  expect(state().head.id).toBe(head);
}, 30_000);

test("same-file concurrent edits retain the local version and save the other version for recovery", async () => {
  const { first, second, farm } = await pair();
  file(first, "memory/farm.md", "original");
  await first.client.request("account.refresh", {});
  await second.client.request("account.refresh", {});
  file(first, "memory/farm.md", "first PC");
  file(second, "memory/farm.md", "second PC");
  await first.client.request("account.refresh", {});
  await second.client.request("account.refresh", {});
  expect(text(second, "memory/farm.md")).toBe("second PC");
  const conflicts = join(farmDir(second.dir), "farm-code", farm.id, "conflicts");
  const [head = ""] = readdirSync(conflicts);
  const recovery = JSON.parse(readFileSync(join(conflicts, head, "versions.json"), "utf8"));
  const hash = recovery.remote.manifest.workspace["memory/farm.md"];
  expect(Buffer.from(recovery.blobs[hash], "base64").toString()).toBe("first PC");
  expect(readFileSync(join(farmDir(second.dir), "farm-code", "notice.txt"), "utf8")).toContain(
    "memory/farm.md",
  );
}, 30_000);
