import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { webcrypto } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pg } from "@orbit/schema";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  type AppOptions,
  type CoreDb,
  coreSchema,
  createApp,
  createLogMailer,
  createTokenResolver,
  farmInvites,
  llmUsage,
  migrate,
  userSessions,
  users,
} from "../src";
import { farmSubscriptions } from "../src/db";

const FARM = "00000000-0000-4000-8000-0000000000f1";
const OTHER_FARM = "00000000-0000-4000-8000-0000000000f2";
const LEGACY = "legacy-token";
const PASSWORD = "correct horse battery";

let client: PGlite;
let db: CoreDb;
let clock = Date.parse("2026-11-05T12:00:00Z");
const mail = createLogMailer(() => {});

/** The code in the newest email of `template` sent to `to` (verify or reset link). */
function codeFrom(to: string, template: string): string {
  const message = mail.sent.findLast((m) => m.to === to && m.template === template);
  const code = /(?:verify|reset)=([\w-]+)/.exec(message?.text ?? "")?.[1];
  if (!code) throw new TypeError(`no ${template} email to ${to}`);
  return code;
}

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
  mail.sent.length = 0;
  await db.execute(
    sql`TRUNCATE farms, animals, devices, device_bindings, connectors, observations, cameras, api_tokens, farm_budgets, llm_usage, farm_invites, farm_members, user_sessions, email_tokens, login_failures, farm_subscriptions, billing_customers, users CASCADE`,
  );
});

function app(extra: Partial<AppOptions> = {}) {
  return createApp({
    db,
    resolveToken: createTokenResolver(db, `${LEGACY}:${OTHER_FARM}`),
    electricUrl: "http://electric.internal:3000",
    now: () => new Date(clock),
    loginThrottle: { maxFailures: 3, windowMs: 60_000 },
    mailer: mail,
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
  const r = await call(a, "POST", "/v1/auth/register", {
    email,
    password: PASSWORD,
    name: email,
    acceptTerms: true,
  });
  expect(r.status).toBe(201);
  const verified = await call(a, "POST", "/v1/auth/verify-email", {
    token: codeFrom(email, "verify_email"),
  });
  expect(verified.status).toBe(200);
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
  test("eight-character passwords register; seven characters fail weak_password", async () => {
    const a = app();
    const accepted = await call(a, "POST", "/v1/auth/register", {
      email: "eight@farm.test",
      password: "12345678",
      acceptTerms: true,
    });
    expect(accepted.status).toBe(201);
    const rejected = await call(a, "POST", "/v1/auth/register", {
      email: "seven@farm.test",
      password: "1234567",
      acceptTerms: true,
    });
    expect(rejected).toMatchObject({
      status: 400,
      body: { error: { code: "weak_password" } },
    });
  });

  test("register signs in, stores only an argon2id hash and a hashed session token", async () => {
    const a = app();
    const r = await call(a, "POST", "/v1/auth/register", {
      email: "Kari@Farm.Test ",
      password: PASSWORD,
      name: "Kari",
      acceptTerms: true,
    });
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ email: "kari@farm.test", name: "Kari" });
    const token = r.body.session.token as string;
    const [stored] = await db.select().from(users);
    expect(stored?.passwordHash?.startsWith("$argon2id$")).toBe(true);
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
      acceptTerms: true,
    });
    expect(dup.status).toBe(409);
    const weak = await call(a, "POST", "/v1/auth/register", {
      email: "b@farm.test",
      password: "short",
      acceptTerms: true,
    });
    expect(weak.body.error.code).toBe("weak_password");
    const bad = await call(a, "POST", "/v1/auth/register", {
      email: "nope",
      password: PASSWORD,
      acceptTerms: true,
    });
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

describe("Google sign-in", () => {
  const clientId = "website.apps.googleusercontent.com";
  let signingKey: CryptoKey;
  let jwk: webcrypto.JsonWebKey;
  let fetches = 0;

  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    signingKey = pair.privateKey;
    jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  });

  function googleApp(extra: Partial<AppOptions> = {}) {
    fetches = 0;
    return app({
      googleClientIds: [clientId, "desktop.apps.googleusercontent.com"],
      corsOrigins: ["https://pecorva.com"],
      fetch: async (input) => {
        expect(String(input)).toBe("https://www.googleapis.com/oauth2/v3/certs");
        fetches++;
        return Response.json(
          { keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] },
          { headers: { "cache-control": "public, max-age=120" } },
        );
      },
      ...extra,
    });
  }

  async function credential(claims: Record<string, unknown> = {}, key = signingKey) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", kid: "test-key" })}.${encode({
      iss: "https://accounts.google.com",
      aud: clientId,
      sub: "google-person-1",
      email: "Google@Farm.Test",
      email_verified: true,
      name: "Google Farmer",
      iat: Math.floor(clock / 1000),
      exp: Math.floor(clock / 1000) + 3600,
      ...claims,
    })}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(unsigned),
    );
    return `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
  }

  const signIn = async (a: App, claims: Record<string, unknown> = {}, fields = {}) =>
    call(a, "POST", "/v1/auth/google", {
      credential: await credential(claims),
      acceptTerms: true,
      ...fields,
    });

  test("creates a verified passwordless user, consent and device session without email", async () => {
    const a = googleApp();
    const r = await signIn(a, {}, { dataConsent: true, deviceName: "Website" });
    expect(r).toMatchObject({
      status: 201,
      body: {
        created: true,
        user: { email: "google@farm.test", emailVerified: true, name: "Google Farmer" },
      },
    });
    const [user] = await db.select().from(users);
    expect(user).toMatchObject({
      googleSub: "google-person-1",
      passwordHash: null,
      termsVersion: "2026-11",
    });
    expect(user?.emailVerifiedAt).not.toBeNull();
    expect(user?.termsAcceptedAt).not.toBeNull();
    expect(user?.dataConsentAt).not.toBeNull();
    expect(mail.sent).toHaveLength(0);
    const me = await call(a, "GET", "/v1/me", undefined, as(r.body.session.token));
    expect(me.body.user).toEqual(r.body.user);
    expect(await db.select().from(userSessions)).toMatchObject([{ deviceName: "Website" }]);
  });

  test("returning subjects sign in without terms even when their Google email changes", async () => {
    const a = googleApp();
    const first = await signIn(a);
    const again = await signIn(a, { email: "changed@farm.test" }, { acceptTerms: false });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.user.id).toBe(first.body.user.id);
    expect(again.body.user.email).toBe("google@farm.test");
    expect(again.body.session.token).not.toBe(first.body.session.token);
    expect(await db.select().from(users)).toHaveLength(1);
    expect(fetches).toBe(1);
    clock += 121_000;
    expect((await signIn(a)).status).toBe(200);
    expect(fetches).toBe(2);
  });

  test("links an existing password account by lowercase email and verifies it", async () => {
    const a = googleApp();
    const registered = await call(a, "POST", "/v1/auth/register", {
      email: "google@farm.test",
      password: PASSWORD,
      acceptTerms: true,
    });
    const linked = await signIn(a, {}, { acceptTerms: false });
    expect(linked).toMatchObject({
      status: 200,
      body: { created: false, user: { id: registered.body.user.id, emailVerified: true } },
    });
    const [user] = await db.select().from(users);
    expect(user?.googleSub).toBe("google-person-1");
    expect(await Bun.password.verify(PASSWORD, user?.passwordHash ?? "")).toBe(true);
    expect(
      (await call(a, "POST", "/v1/auth/login", { email: "google@farm.test", password: PASSWORD }))
        .status,
    ).toBe(200);
    expect((await signIn(a, { sub: "different-subject" })).status).toBe(401);
  });

  test.each([
    ["wrong audience", { aud: "untrusted-client" }],
    ["expired", { exp: Math.floor(Date.parse("2026-11-05T12:00:00Z") / 1000) - 61 }],
    ["future issued", { iat: Math.floor(Date.parse("2026-11-05T12:00:00Z") / 1000) + 61 }],
    ["wrong issuer", { iss: "https://attacker.test" }],
    ["missing subject", { sub: "" }],
  ])("rejects %s tokens", async (_label, claims) => {
    expect(await signIn(googleApp(), claims)).toMatchObject({
      status: 401,
      body: { error: { code: "invalid_google_token" } },
    });
    expect(await db.select().from(users)).toHaveLength(0);
  });

  test("rejects a bad signature and malformed credentials", async () => {
    const a = googleApp();
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      false,
      ["sign", "verify"],
    );
    for (const token of [await credential({}, pair.privateKey), "bad.token", null]) {
      expect(await call(a, "POST", "/v1/auth/google", { credential: token })).toMatchObject({
        status: 401,
        body: { error: { code: "invalid_google_token" } },
      });
    }
  });

  test.each([{ email_verified: false }, { email_verified: "true" }, { email: null }])(
    "requires a verified email: %j",
    async (claims) => {
      expect(await signIn(googleApp(), claims)).toMatchObject({
        status: 400,
        body: { error: { code: "google_email_unverified" } },
      });
    },
  );

  test("new users must accept terms and missing configuration disables sign-in", async () => {
    const a = googleApp();
    expect(
      await call(a, "POST", "/v1/auth/google", { credential: await credential() }),
    ).toMatchObject({
      status: 400,
      body: { error: { code: "terms_required" } },
    });
    expect(await db.select().from(users)).toHaveLength(0);
    expect(await signIn(app())).toMatchObject({
      status: 503,
      body: { error: { code: "google_disabled" } },
    });
  });

  test("passwordless login and change fail cleanly; reset can set an eight-character password", async () => {
    const a = googleApp();
    const google = await signIn(a);
    for (const password of [PASSWORD, "orbit-dummy-password"]) {
      expect(
        await call(a, "POST", "/v1/auth/login", { email: "google@farm.test", password }),
      ).toMatchObject({ status: 401, body: { error: { code: "invalid_credentials" } } });
    }
    expect(
      await call(
        a,
        "POST",
        "/v1/me/password",
        { currentPassword: "orbit-dummy-password", newPassword: PASSWORD },
        as(google.body.session.token),
      ),
    ).toMatchObject({ status: 401, body: { error: { code: "invalid_credentials" } } });
    await call(a, "POST", "/v1/auth/password-reset", { email: "google@farm.test" });
    expect(
      (
        await call(a, "POST", "/v1/auth/password-reset/confirm", {
          token: codeFrom("google@farm.test", "password_reset"),
          password: "12345678",
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await call(a, "POST", "/v1/auth/login", {
          email: "google@farm.test",
          password: "12345678",
        })
      ).status,
    ).toBe(200);
  });

  test("permits the Pecorva website CORS preflight and response", async () => {
    const a = googleApp();
    const preflight = await a.request("/v1/auth/google", {
      method: "OPTIONS",
      headers: {
        origin: "https://pecorva.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://pecorva.com");
    const response = await a.request("/v1/auth/google", {
      method: "POST",
      headers: { origin: "https://pecorva.com", "content-type": "application/json" },
      body: JSON.stringify({
        credential: await credential({
          iss: "accounts.google.com",
          aud: "desktop.apps.googleusercontent.com",
        }),
        acceptTerms: true,
      }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://pecorva.com");
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
      { farmId: r.body.farm.id, role: "owner", name: "Fjord stable", plan: "free" },
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
    await db
      .insert(farmSubscriptions)
      .values({ farmId: FARM, plan: "cam2", interval: "month", status: "active" });
    const r = await call(
      a,
      "POST",
      "/v1/llm/v1/chat/completions",
      { model: "orbit-default", messages: [] },
      as(viewer.token, FARM),
    );
    expect(r.status).toBe(200);
    expect(sent.model).toBe("gpt-real");
    // Without a small model configured, short background jobs still get an answer.
    await call(
      a,
      "POST",
      "/v1/llm/v1/chat/completions",
      { model: "orbit-small", messages: [] },
      as(viewer.token, FARM),
    );
    expect(sent.model).toBe("gpt-real");
    expect(await db.select().from(llmUsage)).toMatchObject([
      { farmId: FARM, model: "gpt-real", totalTokens: 7 },
      { farmId: FARM, model: "gpt-real", totalTokens: 7 },
    ]);
  });
});

describe("account lifecycle", () => {
  test("sign-up requires accepting the terms and records the data-sharing choice", async () => {
    const a = app();
    const refused = await call(a, "POST", "/v1/auth/register", {
      email: "kari@farm.test",
      password: PASSWORD,
    });
    expect(refused).toMatchObject({ status: 400, body: { error: { code: "terms_required" } } });
    const ok = await call(a, "POST", "/v1/auth/register", {
      email: "kari@farm.test",
      password: PASSWORD,
      acceptTerms: true,
      dataConsent: true,
    });
    expect(ok.body.user.emailVerified).toBe(false);
    const [stored] = await db.select().from(users);
    expect(stored).toMatchObject({ termsVersion: "2026-11" });
    expect(stored?.termsAcceptedAt).not.toBeNull();
    expect(stored?.dataConsentAt).not.toBeNull();
  });

  test("a verify link works once, only before it expires, and gates invite acceptance", async () => {
    const a = app();
    const owner = await register(a, "owner@farm.test");
    await call(a, "POST", "/v1/farms", { id: FARM, name: "Hill farm" }, as(owner.token));
    const invite = await call(
      a,
      "POST",
      `/v1/farms/${FARM}/invites`,
      { email: "ola@farm.test", role: "worker" },
      as(owner.token),
    );
    expect(mail.sent.at(-1)).toMatchObject({ to: "ola@farm.test", template: "farm_invite" });
    expect(mail.sent.at(-1)?.text).toContain(invite.body.code);
    const ola = await call(a, "POST", "/v1/auth/register", {
      email: "ola@farm.test",
      password: PASSWORD,
      acceptTerms: true,
    });
    const token = ola.body.session.token as string;
    const early = await call(
      a,
      "POST",
      "/v1/invites/accept",
      { code: invite.body.code },
      as(token),
    );
    expect(early).toMatchObject({ status: 403, body: { error: { code: "email_unverified" } } });

    const code = codeFrom("ola@farm.test", "verify_email");
    clock += 49 * 60 * 60 * 1000;
    expect((await call(a, "POST", "/v1/auth/verify-email", { token: code })).status).toBe(410);
    expect((await call(a, "POST", "/v1/auth/resend-verification", {}, as(token))).status).toBe(202);
    const again = await call(a, "POST", "/v1/auth/resend-verification", {}, as(token));
    expect(again.status).toBe(429);
    const fresh = codeFrom("ola@farm.test", "verify_email");
    expect((await call(a, "POST", "/v1/auth/verify-email", { token: fresh })).status).toBe(200);
    expect((await call(a, "POST", "/v1/auth/verify-email", { token: fresh })).status).toBe(410);
    expect((await call(a, "GET", "/v1/me", undefined, as(token))).body.user.emailVerified).toBe(
      true,
    );
    clock = Date.parse("2026-11-05T12:00:00Z");
    expect(
      (await call(a, "POST", "/v1/invites/accept", { code: invite.body.code }, as(token))).status,
    ).toBe(200);
  });

  test("password reset never reveals accounts, signs out everywhere and works once", async () => {
    const a = app();
    const kari = await register(a, "kari@farm.test");
    const unknown = await call(a, "POST", "/v1/auth/password-reset", { email: "who@farm.test" });
    expect(unknown.status).toBe(202);
    const known = await call(a, "POST", "/v1/auth/password-reset", { email: "kari@farm.test" });
    expect(known).toEqual({ status: 202, body: unknown.body });
    expect(mail.sent.filter((m) => m.template === "password_reset").map((m) => m.to)).toEqual([
      "kari@farm.test",
    ]);
    const code = codeFrom("kari@farm.test", "password_reset");
    const reset = await call(a, "POST", "/v1/auth/password-reset/confirm", {
      token: code,
      password: "a brand new password",
    });
    expect(reset.status).toBe(204);
    expect((await call(a, "GET", "/v1/me", undefined, as(kari.token))).status).toBe(401);
    const reuse = await call(a, "POST", "/v1/auth/password-reset/confirm", {
      token: code,
      password: "another new password",
    });
    expect(reuse.status).toBe(410);
    const oldLogin = await call(a, "POST", "/v1/auth/login", {
      email: "kari@farm.test",
      password: PASSWORD,
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await call(a, "POST", "/v1/auth/login", {
      email: "kari@farm.test",
      password: "a brand new password",
    });
    expect(newLogin.status).toBe(200);
    expect(mail.sent.at(-1)).toMatchObject({ template: "password_changed" });
  });

  test("sessions are listed per device and can be revoked one by one", async () => {
    const a = app();
    const first = await register(a, "kari@farm.test");
    const second = await call(a, "POST", "/v1/auth/login", {
      email: "kari@farm.test",
      password: PASSWORD,
      deviceName: "Barn PC",
    });
    const listed = await call(a, "GET", "/v1/me/sessions", undefined, as(first.token));
    expect(listed.body.sessions).toHaveLength(2);
    const barn = listed.body.sessions.find(
      (s: { deviceName: string }) => s.deviceName === "Barn PC",
    );
    expect(barn.current).toBe(false);
    const revoke = await call(
      a,
      "DELETE",
      `/v1/me/sessions/${barn.id}`,
      undefined,
      as(first.token),
    );
    expect(revoke.status).toBe(204);
    expect((await call(a, "GET", "/v1/me", undefined, as(second.body.session.token))).status).toBe(
      401,
    );
    expect((await call(a, "GET", "/v1/me", undefined, as(first.token))).status).toBe(200);
  });

  test("deleting an account needs the plan cancelled, wipes the sole-owned cloud farm and keeps exports", async () => {
    const a = app();
    const kari = await register(a, "kari@farm.test");
    await call(a, "POST", "/v1/farms", { id: FARM, name: "Hill farm" }, as(kari.token));
    await db
      .insert(farmSubscriptions)
      .values({ farmId: FARM, plan: "cam2", interval: "month", status: "active" });
    const exported = await call(a, "GET", "/v1/me/export", undefined, as(kari.token));
    expect(exported.body).toMatchObject({
      profile: { email: "kari@farm.test", termsVersion: "2026-11" },
      memberships: [{ farmId: FARM, role: "owner", plan: "cam2" }],
    });
    const wrong = await call(a, "DELETE", "/v1/me", { password: "not it at all" }, as(kari.token));
    expect(wrong.status).toBe(401);
    const blocked = await call(a, "DELETE", "/v1/me", { password: PASSWORD }, as(kari.token));
    expect(blocked).toMatchObject({
      status: 409,
      body: { error: { code: "subscription_active" } },
    });
    await db.update(farmSubscriptions).set({ cancelAtPeriodEnd: true });
    const deleted = await call(a, "DELETE", "/v1/me", { password: PASSWORD }, as(kari.token));
    expect(deleted.status).toBe(204);
    expect(await db.select().from(users)).toEqual([]);
    expect(await db.select().from(userSessions)).toEqual([]);
    expect((await call(a, "GET", "/v1/me", undefined, as(kari.token))).status).toBe(401);
  });

  test("an Orbit farm adopts the empty cloud farm bought on the website, plan included", async () => {
    const a = app();
    const kari = await register(a, "kari@farm.test");
    const bought = await call(a, "POST", "/v1/farms", { name: "Website farm" }, as(kari.token));
    const websiteFarm = bought.body.farm.id as string;
    await db
      .insert(farmSubscriptions)
      .values({ farmId: websiteFarm, plan: "cam2", interval: "year", status: "active" });
    expect((await call(a, "GET", "/v1/me", undefined, as(kari.token))).body.farms).toMatchObject([
      { farmId: websiteFarm, plan: "cam2" },
    ]);
    const stranger = await register(a, "who@farm.test");
    const theft = await call(
      a,
      "POST",
      "/v1/farms",
      { id: OTHER_FARM, name: "Mine", adopt: websiteFarm },
      as(stranger.token),
    );
    expect(theft.status).toBe(403);
    const adopted = await call(
      a,
      "POST",
      "/v1/farms",
      { id: FARM, name: "Hill farm", adopt: websiteFarm },
      as(kari.token),
    );
    expect(adopted).toMatchObject({ status: 201, body: { farm: { id: FARM, role: "owner" } } });
    expect((await call(a, "GET", "/v1/me", undefined, as(kari.token))).body.farms).toMatchObject([
      { farmId: FARM, role: "owner", plan: "cam2" },
    ]);
    expect(await db.select().from(pg.farms).where(eq(pg.farms.id, websiteFarm))).toEqual([]);
    const status = await call(a, "GET", "/v1/billing/status", undefined, as(kari.token, FARM));
    expect(status.body).toMatchObject({ plan: "cam2", status: "active" });
  });

  test("a cloud farm that already holds data is never adopted", async () => {
    const a = app();
    const kari = await register(a, "kari@farm.test");
    const made = await call(a, "POST", "/v1/farms", { name: "Busy farm" }, as(kari.token));
    const busy = made.body.farm.id as string;
    const ts = new Date(clock).toISOString();
    await db.insert(pg.animals).values({
      id: crypto.randomUUID(),
      farmId: busy,
      species: "cattle",
      createdAt: ts,
      updatedAt: ts,
      hlc: hlc(0),
      originDevice: "cloud",
    });
    const res = await call(
      a,
      "POST",
      "/v1/farms",
      { id: FARM, name: "Hill farm", adopt: busy },
      as(kari.token),
    );
    expect(res).toMatchObject({ status: 409, body: { error: { code: "farm_not_empty" } } });
  });
});
