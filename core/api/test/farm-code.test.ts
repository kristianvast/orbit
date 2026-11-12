import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { FARM_CODE_MAX_FILE_BYTES, type FarmCodePush } from "@orbit/protocol";
import { type FarmRole, pg } from "@orbit/schema";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createApp } from "../src/app";
import { createSession } from "../src/auth";
import { type CoreDb, coreSchema, farmMembers, users } from "../src/db";
import { migrate } from "../src/migrate";

const FARM = "00000000-0000-4000-8000-0000000000f1";
const OTHER = "00000000-0000-4000-8000-0000000000f2";
let client: PGlite;
let db: CoreDb;
let app: ReturnType<typeof createApp>;
let owner: string;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle({ client, schema: coreSchema }) as unknown as CoreDb;
  await migrate(db);
  app = createApp({ db, resolveToken: async () => FARM, electricUrl: "http://electric.test" });
}, 60_000);
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE farm_code_heads, farm_code_commits, farm_code_blobs, farms, users, farm_members, user_sessions CASCADE`,
  );
  for (const id of [FARM, OTHER]) {
    await db.insert(pg.farms).values({
      id,
      farmId: id,
      name: "Farm",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hlc: "000000000000001:000000:pc",
      originDevice: "pc",
    });
  }
  owner = await member("owner", FARM);
});

async function member(role: FarmRole, farmId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(users).values({ id, email: `${id}@test.example` });
  await db.insert(farmMembers).values({ farmId, userId: id, role });
  return (await createSession(db, id, "PC", new Date())).token;
}
function commit(content = "farm code", path = "memory/farm.md"): FarmCodePush {
  const bytes = Buffer.from(content);
  const hash = createHash("sha256").update(bytes).digest("hex");
  return {
    parent: null,
    manifest: { workspace: { [path]: hash }, app: null },
    blobs: { [hash]: bytes.toString("base64") },
  };
}
async function call(token: string, route: string, body?: unknown, farm = FARM) {
  return app.request(`/v1/farm-code/${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-orbit-farm": farm,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("a commit restores its manifest and only that farm can fetch its blobs", async () => {
  const payload = commit();
  const [hash = ""] = Object.keys(payload.blobs);
  payload.manifest.app = {
    baseCommit: "a".repeat(40),
    files: { "apps/orbit/src/farm.ts": { base: null, content: hash } },
  };
  const pushed = await call(owner, "commits", payload);
  expect(pushed.status).toBe(200);
  const result = await pushed.json();
  expect(await (await call(owner, "head")).json()).toEqual(result);
  const hashes = Object.keys(payload.blobs);
  expect(await (await call(owner, "blobs/fetch", { hashes })).json()).toEqual({
    blobs: payload.blobs,
  });
  const stranger = await member("owner", OTHER);
  expect((await call(stranger, "head")).status).toBe(403);
  expect(await (await call(stranger, "blobs/fetch", { hashes }, OTHER)).json()).toEqual({
    blobs: {},
  });
});

test.each(["owner", "manager", "worker", "viewer"] as const)(
  "members with role %s read but only code editors push",
  async (role) => {
    const token = await member(role, FARM);
    expect((await call(token, "head")).status).toBe(200);
    expect((await call(token, "commits", commit())).status).toBe(
      role === "owner" || role === "manager" ? 200 : 403,
    );
  },
);

test("legacy tokens cannot read or write farm code", async () => {
  expect((await call("legacy", "head")).status).toBe(401);
  expect((await call("legacy", "commits", commit())).status).toBe(401);
});

test("concurrent commits with one parent cannot overwrite each other", async () => {
  const results = await Promise.all([
    call(owner, "commits", commit("one")),
    call(owner, "commits", commit("two")),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  const winner = results.find((r) => r.status === 200);
  expect(await (await call(owner, "head")).json()).toEqual(await winner?.json());
});

test.each([".env", "../secret", "/absolute", "node_modules/lib.js", "pages/x/.git/config"])(
  "refuses unsafe path %s",
  async (path) => {
    expect((await call(owner, "commits", commit("safe", path))).status).toBe(400);
  },
);

test.each([
  'api_key = "sk-private-value-1234567890"',
  "-----BEGIN PRIVATE KEY-----\nsensitive",
  "x".repeat(FARM_CODE_MAX_FILE_BYTES + 1),
])("rejects secret content or an oversized file", async (content) => {
  expect((await call(owner, "commits", commit(content))).status).toBe(400);
});

test("rejects absent and incorrectly hashed blobs without advancing the head", async () => {
  const payload = commit();
  expect((await call(owner, "commits", { ...payload, blobs: {} })).status).toBe(400);
  const [hash = ""] = Object.keys(payload.blobs);
  expect(
    (
      await call(owner, "commits", {
        ...payload,
        blobs: { [hash]: Buffer.from("wrong").toString("base64") },
      })
    ).status,
  ).toBe(400);
  expect(await (await call(owner, "head")).json()).toEqual({ head: null });
});

test("bounds expanded file bytes even when many paths reuse one blob", async () => {
  const payload = commit("x".repeat(FARM_CODE_MAX_FILE_BYTES));
  const [hash = ""] = Object.keys(payload.blobs);
  payload.manifest.workspace = Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`copy-${i}.txt`, hash]),
  );
  expect((await call(owner, "commits", payload)).status).toBe(400);
});
