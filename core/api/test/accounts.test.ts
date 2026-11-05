import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { pg } from "@orbit/schema";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  type AppOptions,
  type CoreDb,
  coreSchema,
  createApp,
  createTokenResolver,
  farmInvites,
  llmUsage,
  migrate,
  userSessions,
  users,
} from "../src";

const FARM = "00000000-0000-4000-8000-0000000000f1";
const OTHER_FARM = "00000000-0000-4000-8000-0000000000f2";
const LEGACY = "legacy-token";
const PASSWORD = "correct horse battery";

let client: PGlite;
let db: CoreDb;
let clock = Date.parse("2026-11-05T12:00:00Z");

beforeAll(async () => {
  client = new PGlite();
  db = drizzle({ client, schema: coreSchema }) as unknown as CoreDb;
  await migrate(db);
}, 60_000);
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  clock = Date.parse("2026-11-05T12:00:00Z");
  await db.execute(
    sql`TRUNCATE farms, animals, devices, device_bindings, connectors, observations, cameras, api_tokens, farm_budgets, llm_usage, farm_invites, farm_members, user_sessions, users CASCADE`,
  );
});

function app(extra: Partial<AppOptions> = {}) {
  return createApp({
    db,
    resolveToken: createTokenResolver(db, `${LEGACY}:${OTHER_FARM}`),
    electricUrl: "http://electric.internal:3000",
    now: () => new Date(clock),
    loginThrottle: { maxFailures: 3, windowMs: 60_000 },
    ...extra,
  });
}

type App = ReturnType<typeof app>;

async function call(a: App, method: string, path: string, body?: unknown, headers = {}) {
  const res = await a.request(path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function register(a: App, email: string) {
  const r = await call(a, "POST", "/v1/auth/register", { email, password: PASSWORD, name: email });
  expect(r.status).toBe(201);
  return { token: r.body.session.token as string, id: r.body.user.id as string };
}

const as = (token: string, farm?: string) => ({
  authorization: `Bearer ${token}`,
  ...(farm ? { "x-orbit-farm": farm } : {}),
});

async function memberWith(a: App, ownerToken: string, email: string, role: string) {
  const invite = await call(
    a,
    "POST",
    `/v1/farms/${FARM}/invites`,
    { email, role },
    as(ownerToken),
  );
  expect(invite.status).toBe(201);
  const user = await register(a, email);
  expect(
    (await call(a, "POST", "/v1/invites/accept", { code: invite.body.code }, as(user.token)))
      .status,
  ).toBe(200);
  return user;
}

async function ownerOfFarm(a: App) {
  const owner = await register(a, "owner@farm.test");
  const claim = await call(
    a,
    "POST",
    "/v1/farms",
    { id: FARM, name: "Hill farm" },
    as(owner.token),
  );
  expect(claim.status).toBe(201);
  return owner;
}

const hlc = (n: number) =>
  `${String(Date.parse("2026-11-05T00:00:00Z") + n).padStart(15, "0")}:000000:pc`;
const base = (id: string, n: number) => ({
  id,
  farm_id: FARM,
  created_at: "2026-11-05T00:00:00.000Z",
  updated_at: "2026-11-05T00:00:00.000Z",
  deleted_at: null,
  hlc: hlc(n),
  origin_device: "pc",
});
const animal = (n: number) => ({
  ...base("00000000-0000-4000-8000-0000000000a1", n),
  species: "cattle",
  name: "Dagros",
  ear_tag_number: "1001",
  national_id: null,
  breed: null,
  sex: "female",
  birth_date: null,
  group_name: null,
  status: "active",
  notes: null,
});
const connector = (n: number) => ({
  ...base("00000000-0000-4000-8000-0000000000c1", n),
  kind: "file_import",
  vendor: "generic_csv",
  name: "Export",
  config: {},
  enabled: true,
  last_sync_at: null,
  last_error: null,
});

async function push(
  a: App,
  headers: Record<string, string>,
  table: string,
  row: { id: string; hlc: string },
) {
  return call(
    a,
    "POST",
    "/v1/changes",
    { changes: [{ seq: 1, op: "insert", table, rowId: row.id, hlc: row.hlc, row }] },
    headers,
  );
}

describe("registration and sign-in", () => {
  test("register signs in, stores only an argon2id hash and a hashed session token", async () => {
    const a = app();
    const r = await call(a, "POST", "/v1/auth/register", {
      email: "Kari@Farm.Test ",
      password: PASSWORD,
      name: "Kari",
    });
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ email: "kari@farm.test", name: "Kari" });
    const token = r.body.session.token as string;
    const [stored] = await db.select().from(users);
    expect(stored?.passwordHash.startsWith("$argon2id$")).toBe(true);
    const sessions = await db.select().from(userSessions);
    expect(sessions.map((s) => s.tokenHash)).not.toContain(token);
    const me = await call(a, "GET", "/v1/me", undefined, as(token));
    expect(me).toMatchObject({
      status: 200,
      body: { user: { email: "kari@farm.test" }, farms: [] },
    });
  });

  test("duplicate emails, weak passwords and bad addresses are refused", async () => {
    const a = app();
    await register(a, "kari@farm.test");
    const dup = await call(a, "POST", "/v1/auth/register", {
      email: "KARI@farm.test",
      password: PASSWORD,
    });
    expect(dup.status).toBe(409);
    const weak = await call(a, "POST", "/v1/auth/register", {
      email: "b@farm.test",
      password: "short",
    });
    expect(weak.body.error.code).toBe("weak_password");
    const bad = await call(a, "POST", "/v1/auth/register", { email: "nope", password: PASSWORD });
    expect(bad.status).toBe(400);
  });

  test("wrong passwords and unknown emails get the same 401, then 429 after repeated failures", async () => {
    const a = app();
    await register(a, "kari@farm.test");
    const wrong = await call(a, "POST", "/v1/auth/login", {
      email: "kari@farm.test",
      password: "x".repeat(12),
    });
    const unknown = await call(a, "POST", "/v1/auth/login", {
      email: "who@farm.test",
      password: PASSWORD,
    });
    expect(wrong).toEqual({ status: 401, body: unknown.body });
    await call(a, "POST", "/v1/auth/login", { email: "kari@farm.test", password: "y".repeat(12) });
    await call(a, "POST", "/v1/auth/login", { email: "kari@farm.test", password: "z".repeat(12) });
    const locked = await call(a, "POST", "/v1/auth/login", {
      email: "kari@farm.test",
      password: PASSWORD,
    });
    expect(locked.status).toBe(429);
    clock += 61_000;
    const ok = await call(a, "POST", "/v1/auth/login", {
      email: "kari@farm.test",
      password: PASSWORD,
    });
    expect(ok.status).toBe(200);
  });

  test("logout revokes the session and expired sessions stop working", async () => {
    const a = app();
    const { token } = await register(a, "kari@farm.test");
    expect((await call(a, "POST", "/v1/auth/logout", undefined, as(token))).status).toBe(204);
    expect((await call(a, "GET", "/v1/me", undefined, as(token))).status).toBe(401);
    const login = await call(a, "POST", "/v1/auth/login", {
      email: "kari@farm.test",
      password: PASSWORD,
    });
    clock += 91 * 24 * 60 * 60 * 1000;
    expect((await call(a, "GET", "/v1/me", undefined, as(login.body.session.token))).status).toBe(
      401,
    );
  });
});

describe("farms and members", () => {
  test("claiming a local farm id makes the caller owner; a second claim is refused", async () => {
    const a = app();
    const owner = await ownerOfFarm(a);
    const again = await call(
      a,
      "POST",
      "/v1/farms",
      { id: FARM, name: "Hill farm" },
      as(owner.token),
    );
    expect(again.status).toBe(200);
    const other = await register(a, "thief@farm.test");
    const steal = await call(a, "POST", "/v1/farms", { id: FARM, name: "Mine" }, as(other.token));
    expect(steal).toMatchObject({ status: 409, body: { error: { code: "farm_taken" } } });
    await db.insert(pg.farms).values({
      id: OTHER_FARM,
      name: "Synced before accounts",
      farmId: OTHER_FARM,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      hlc: hlc(0),
      originDevice: "pc",
    });
    const known = await call(
      a,
      "POST",
      "/v1/farms",
      { id: OTHER_FARM, name: "x" },
      as(other.token),
    );
    expect(known).toMatchObject({ status: 409, body: { error: { code: "farm_taken" } } });
  });

  test("creating a new farm writes the farm row and lists it in /v1/me", async () => {
    const a = app();
    const { token } = await register(a, "kari@farm.test");
    const r = await call(a, "POST", "/v1/farms", { name: "Fjord stable" }, as(token));
    expect(r.status).toBe(201);
    const [row] = await db.select().from(pg.farms).where(eq(pg.farms.id, r.body.farm.id));
    expect(row).toMatchObject({ name: "Fjord stable", originDevice: "cloud" });
    const me = await call(a, "GET", "/v1/me", undefined, as(token));
    expect(me.body.farms).toEqual([
      { farmId: r.body.farm.id, role: "owner", name: "Fjord stable" },
    ]);
  });

  test("owners and managers manage members within their rank; the last owner stays", async () => {
    const a = app();
    const owner = await ownerOfFarm(a);
    const manager = await memberWith(a, owner.token, "manager@farm.test", "manager");
    const worker = await memberWith(a, manager.token, "worker@farm.test", "worker");
    const members = await call(a, "GET", `/v1/farms/${FARM}/members`, undefined, as(worker.token));
    expect(members.body.members.map((m: { role: string }) => m.role)).toEqual([
      "owner",
      "manager",
      "worker",
    ]);

    const promote = (who: string, by: string, role: string) =>
      call(a, "PATCH", `/v1/farms/${FARM}/members/${who}`, { role }, as(by));
    expect((await promote(worker.id, manager.token, "owner")).status).toBe(403);
    expect((await promote(owner.id, manager.token, "viewer")).status).toBe(403);
    expect((await promote(manager.id, worker.token, "viewer")).status).toBe(403);
    expect((await promote(worker.id, manager.token, "viewer")).status).toBe(200);
    expect((await promote(owner.id, owner.token, "manager")).body.error.code).toBe("last_owner");
    const leave = await call(
      a,
      "DELETE",
      `/v1/farms/${FARM}/members/${owner.id}`,
      undefined,
      as(owner.token),
    );
    expect(leave.status).toBe(409);
    const kick = await call(
      a,
      "DELETE",
      `/v1/farms/${FARM}/members/${worker.id}`,
      undefined,
      as(manager.token),
    );
    expect(kick.status).toBe(204);
    expect(
      (await call(a, "GET", `/v1/farms/${FARM}/members`, undefined, as(worker.token))).status,
    ).toBe(403);
  });
});

describe("invites", () => {
  test("only the invited email can accept, once, before expiry; revoked codes stop working", async () => {
    const a = app();
    const owner = await ownerOfFarm(a);
    const mk = async (email: string) =>
      (
        await call(
          a,
          "POST",
          `/v1/farms/${FARM}/invites`,
          { email, role: "worker" },
          as(owner.token),
        )
      ).body;
    const invite = await mk("ola@farm.test");
    expect(invite.code.startsWith("orb_i_")).toBe(true);
    expect(invite.invite.expiresAt).toBe("2026-11-12T12:00:00.000Z");
    const [stored] = await db.select().from(farmInvites);
    expect(stored?.tokenHash).not.toBe(invite.code);

    const stranger = await register(a, "stranger@farm.test");
    const wrong = await call(
      a,
      "POST",
      "/v1/invites/accept",
      { code: invite.code },
      as(stranger.token),
    );
    expect(wrong).toMatchObject({ status: 403, body: { error: { code: "wrong_account" } } });
    const ola = await register(a, "ola@farm.test");
    const ok = await call(a, "POST", "/v1/invites/accept", { code: invite.code }, as(ola.token));
    expect(ok.body).toEqual({ farm: { id: FARM, role: "worker" } });
    const reused = await call(
      a,
      "POST",
      "/v1/invites/accept",
      { code: invite.code },
      as(ola.token),
    );
    expect(reused.status).toBe(409);

    const late = await mk("late@farm.test");
    const lateUser = await register(a, "late@farm.test");
    clock += 8 * 24 * 60 * 60 * 1000;
    const expired = await call(
      a,
      "POST",
      "/v1/invites/accept",
      { code: late.code },
      as(lateUser.token),
    );
    expect(expired).toMatchObject({ status: 410, body: { error: { code: "invite_expired" } } });

    const owner2 = await call(a, "POST", "/v1/auth/login", {
      email: "owner@farm.test",
      password: PASSWORD,
    });
    const t = owner2.body.session.token;
    const withdrawn = (
      await call(
        a,
        "POST",
        `/v1/farms/${FARM}/invites`,
        { email: "w@farm.test", role: "viewer" },
        as(t),
      )
    ).body;
    const pending = await call(a, "GET", `/v1/farms/${FARM}/invites`, undefined, as(t));
    expect(pending.body.invites.map((i: { email: string }) => i.email)).toEqual(["w@farm.test"]);
    expect(
      (
        await call(
          a,
          "DELETE",
          `/v1/farms/${FARM}/invites/${withdrawn.invite.id}`,
          undefined,
          as(t),
        )
      ).status,
    ).toBe(204);
    const w = await register(a, "w@farm.test");
    expect(
      (await call(a, "POST", "/v1/invites/accept", { code: withdrawn.code }, as(w.token))).status,
    ).toBe(410);
  });

  test("workers cannot invite and managers cannot invite owners", async () => {
    const a = app();
    const owner = await ownerOfFarm(a);
    const manager = await memberWith(a, owner.token, "m@farm.test", "manager");
    const worker = await memberWith(a, owner.token, "w@farm.test", "worker");
    const by = (t: string, role: string) =>
      call(a, "POST", `/v1/farms/${FARM}/invites`, { email: "new@farm.test", role }, as(t));
    expect((await by(worker.token, "viewer")).status).toBe(403);
    expect((await by(manager.token, "owner")).status).toBe(403);
    expect((await by(manager.token, "worker")).status).toBe(201);
    expect((await by(owner.token, "manager")).status).toBe(201);
    const dupe = await call(
      a,
      "POST",
      `/v1/farms/${FARM}/invites`,
      { email: "w@farm.test", role: "viewer" },
      as(owner.token),
    );
    expect(dupe.status).toBe(409);
  });
});

describe("farm data with user sessions", () => {
  test("roles decide which tables a member may change", async () => {
    const a = app();
    const owner = await ownerOfFarm(a);
    const worker = await memberWith(a, owner.token, "w@farm.test", "worker");
    const viewer = await memberWith(a, owner.token, "v@farm.test", "viewer");

    const w = as(worker.token, FARM);
    expect((await push(a, w, "animals", animal(1))).body.results[0]).toMatchObject({
      status: "applied",
    });
    expect((await push(a, w, "connectors", connector(1))).body.results[0]).toEqual({
      seq: 1,
      status: "rejected",
      error: "a worker may not change connectors",
    });
    expect(
      (await push(a, as(viewer.token, FARM), "animals", animal(2))).body.results[0],
    ).toMatchObject({
      status: "rejected",
      error: "a viewer may not change animals",
    });
    expect(
      (await push(a, as(owner.token, FARM), "connectors", connector(3))).body.results[0],
    ).toMatchObject({
      status: "applied",
    });
  });

  test("sessions need the farm header and a membership; legacy farm tokens still work", async () => {
    const a = app();
    const owner = await ownerOfFarm(a);
    const outsider = await register(a, "out@farm.test");
    expect((await push(a, as(owner.token), "animals", animal(1))).status).toBe(400);
    expect((await push(a, as(outsider.token, FARM), "animals", animal(1))).status).toBe(403);
    const legacyRow = { ...animal(1), farm_id: OTHER_FARM };
    const legacy = await push(a, { authorization: `Bearer ${LEGACY}` }, "animals", legacyRow);
    expect(legacy.body.results[0]).toMatchObject({ status: "applied" });
    const crossed = await push(a, { ...as(LEGACY), "x-orbit-farm": FARM }, "animals", legacyRow);
    expect(crossed.status).toBe(403);
  });

  test("the cloud model alias maps to Core's default upstream model and is metered per farm", async () => {
    let sent: Record<string, unknown> = {};
    const a = app({
      llm: { upstreamUrl: "https://llm.example", upstreamApiKey: "sk", defaultModel: "gpt-real" },
      fetch: async (_input, init) => {
        sent = JSON.parse(String(init?.body));
        return Response.json({ usage: { prompt_tokens: 5, completion_tokens: 2 } });
      },
    });
    const owner = await ownerOfFarm(a);
    const viewer = await memberWith(a, owner.token, "v@farm.test", "viewer");
    const r = await call(
      a,
      "POST",
      "/v1/llm/v1/chat/completions",
      { model: "orbit-default", messages: [] },
      as(viewer.token, FARM),
    );
    expect(r.status).toBe(200);
    expect(sent.model).toBe("gpt-real");
    expect(await db.select().from(llmUsage)).toMatchObject([
      { farmId: FARM, model: "gpt-real", totalTokens: 7 },
    ]);
  });
});
