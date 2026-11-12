import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createApp } from "../src/app";
import { createSession } from "../src/auth";
import { chatEntries, chatSessions } from "../src/chat-db";
import { type CoreDb, coreSchema, farmMembers, users } from "../src/db";
import { migrate } from "../src/migrate";

const FARM = "00000000-0000-4000-8000-0000000000f1";
const ID = "00000000-0000-4000-8000-0000000000c1";
const OWNER = "00000000-0000-4000-8000-000000000001";
const MEMBER = "00000000-0000-4000-8000-000000000002";
const NOW = "2026-11-12T12:00:00.000Z";
let client: PGlite;
let db: CoreDb;
let app: ReturnType<typeof createApp>;
let token: string;
let member: string;

beforeAll(async () => {
  client = new PGlite();
  // PGlite implements the Postgres adapter used by production Core.
  db = drizzle({ client, schema: coreSchema }) as unknown as CoreDb;
  await migrate(db);
  app = createApp({
    db,
    resolveToken: async (t) => (t === "legacy" ? FARM : null),
    electricUrl: "http://electric.test",
    now: () => new Date(NOW),
  });
}, 60_000);
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE users, farms CASCADE`);
  await db.insert(users).values([
    { id: OWNER, email: "owner@chat.test" },
    { id: MEMBER, email: "member@chat.test" },
  ]);
  token = (await createSession(db, OWNER, null, new Date(NOW))).token;
  member = (await createSession(db, MEMBER, null, new Date(NOW))).token;
  const farm = await app.request("/v1/farms", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ id: FARM, name: "Chat farm" }),
  });
  expect(farm.status).toBe(201);
  await db.insert(farmMembers).values({ farmId: FARM, userId: MEMBER, role: "viewer" });
});

function call(method: string, path: string, body?: unknown, bearer = token, farm = FARM) {
  return app.request(`/v1/chat${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      "x-orbit-farm": farm,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function history(count = 1) {
  return {
    session: { title: "Private chat", createdAt: NOW, updatedAt: NOW, parentSessionId: null },
    header: { type: "session", version: 3, id: ID, timestamp: NOW, cwd: "." },
    entries: Array.from({ length: count }, (_, i) => ({
      type: "message",
      id: `entry-${i}`,
      parentId: i ? `entry-${i - 1}` : null,
      timestamp: NOW,
      message: { role: "user", content: `Question ${i}`, timestamp: 1 },
    })),
  };
}

test("chat history is private to its author even for other farm members", async () => {
  expect((await call("POST", `/sessions/${ID}/entries`, history())).status).toBe(200);
  expect(await (await call("GET", "/sessions", undefined, member)).json()).toMatchObject({
    sessions: [],
  });
  expect((await call("GET", `/sessions/${ID}/entries`, undefined, member)).status).toBe(404);
  await call(
    "PATCH",
    `/sessions/${ID}`,
    { title: "Intrusion", updatedAt: "2026-11-13T00:00:00Z" },
    member,
  );
  await call("DELETE", `/sessions/${ID}`, undefined, member);
  expect(await (await call("GET", "/sessions")).json()).toMatchObject({
    sessions: [{ id: ID, title: "Private chat", messageCount: 1, deletedAt: null }],
  });
});

test("every chat route requires a user session and farm membership", async () => {
  for (const [method, path, body] of [
    ["GET", "/sessions", undefined],
    ["GET", `/sessions/${ID}/entries`, undefined],
    ["POST", `/sessions/${ID}/entries`, history()],
    ["PATCH", `/sessions/${ID}`, { title: "Title", updatedAt: NOW }],
    ["DELETE", `/sessions/${ID}`, undefined],
  ] as const) {
    expect((await call(method, path, body, "legacy")).status).toBe(401);
    expect(
      (await call(method, path, body, token, "00000000-0000-4000-8000-0000000000f2")).status,
    ).toBe(403);
  }
});

test("append unions immutable entry IDs and pages a readable transcript", async () => {
  const body = history(21);
  await call("POST", `/sessions/${ID}/entries`, body);
  await call("POST", `/sessions/${ID}/entries`, history());
  const first = await (await call("GET", `/sessions/${ID}/entries`)).json();
  if (
    !first ||
    typeof first !== "object" ||
    !("entries" in first) ||
    !("header" in first) ||
    !("next" in first)
  )
    throw new TypeError("missing first history page");
  expect(first.entries).toEqual(body.entries.slice(0, 20));
  expect(first.header).toEqual(body.header);
  const second = await (await call("GET", `/sessions/${ID}/entries?after=${first.next}`)).json();
  if (!second || typeof second !== "object" || !("entries" in second) || !("next" in second))
    throw new TypeError("missing second history page");
  expect(second.entries).toEqual(body.entries.slice(20));
  expect(second.next).toBeNull();
  expect(await (await call("GET", "/sessions")).json()).toMatchObject({
    sessions: [{ messageCount: 21 }],
  });
});

test("rename persists and deletion cannot be resurrected by an offline append", async () => {
  await call("POST", `/sessions/${ID}/entries`, history());
  await call("PATCH", `/sessions/${ID}`, { title: "New title", updatedAt: "2026-11-12T13:00:00Z" });
  expect(await (await call("GET", "/sessions")).json()).toMatchObject({
    sessions: [{ title: "New title" }],
  });
  await call("DELETE", `/sessions/${ID}`);
  expect((await call("POST", `/sessions/${ID}/entries`, history())).status).toBe(409);
  expect((await call("GET", `/sessions/${ID}/entries`)).status).toBe(404);
  expect(await (await call("GET", "/sessions")).json()).toMatchObject({
    sessions: [{ deletedAt: NOW }],
  });
});

test("chat writes reject malformed entries and oversized requests", async () => {
  const body = history();
  expect(
    (
      await call("POST", `/sessions/${ID}/entries`, {
        ...body,
        entries: [{ type: "message", id: "broken" }],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call("POST", `/sessions/${ID}/entries`, {
        ...body,
        entries: [{ ...body.entries[0], parentId: "entry-0" }],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call("POST", `/sessions/${ID}/entries`, {
        ...body,
        padding: "x".repeat(1024 * 1024),
      })
    ).status,
  ).toBe(413);
});

test("deleting an author removes their chat history without affecting other authors", async () => {
  await call("POST", `/sessions/${ID}/entries`, history());
  await call("POST", `/sessions/${ID}/entries`, history(), member);
  await db.execute(
    sql`UPDATE users SET password_hash = ${await Bun.password.hash("delete my account")} WHERE id = ${MEMBER}`,
  );
  const response = await app.request("/v1/me", {
    method: "DELETE",
    headers: { authorization: `Bearer ${member}`, "content-type": "application/json" },
    body: JSON.stringify({ password: "delete my account" }),
  });
  expect(response.status).toBe(204);
  expect((await db.select().from(chatSessions)).map((s) => s.userId)).toEqual([OWNER]);
  expect((await db.select().from(chatEntries)).map((e) => e.userId)).toEqual([OWNER]);
});
