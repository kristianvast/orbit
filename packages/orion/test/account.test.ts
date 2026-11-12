// Orion against a real in-process Core (createApp + PGlite on a live port): sign-in, farm linking,
// sync, the cloud model and local role enforcement. Electric and the LLM provider are faked at
// Core's upstream fetch.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { webcrypto } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CoreDb,
  coreSchema,
  createApp,
  createLogMailer,
  createTokenResolver,
  farmMembers,
  llmUsage,
  migrate,
} from "@core/api";
import { PGlite } from "@electric-sql/pglite";
import type { OrionClient } from "@orbit/protocol/client";
import { pg } from "@orbit/schema";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { type OrionApp, startOrion } from "../src/app";
import type { OrionConfig } from "../src/config";
import { EncryptedFileStore } from "../src/secrets";
import { connect, removeDir, TOKEN, tempDir, waitFor } from "./helpers";

process.env.ORION_NO_BROWSER = "1";

const PASSWORD = "correct horse battery";
const GOOGLE_CLIENT = "orbit-test.apps.googleusercontent.com";
const SSE = [
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Hello from the cloud" }, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 4 } })}\n\n`,
  "data: [DONE]\n\n",
];

let pglite: PGlite;
let db: CoreDb;
let core: ReturnType<typeof Bun.serve>;
let coreUrl: string;
let upstream: { model: unknown; auth: string | null }[] = [];
/** When set, answers model requests instead of the default SSE reply (one call per request). */
let scriptedUpstream: ((body: { messages: Record<string, unknown>[] }) => Response) | null = null;
const mail = createLogMailer(() => {});
let googleKey: CryptoKey;
let googleJwk: webcrypto.JsonWebKey;

/** A Google ID token as the website's Google button hands it over, signed by the faked Google keys. */
async function googleCredential(): Promise<string> {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "RS256", kid: "test-key" })}.${encode({
    iss: "https://accounts.google.com",
    aud: GOOGLE_CLIENT,
    sub: "google-person-1",
    email: "Google@Farm.Test",
    email_verified: true,
    name: "Google Farmer",
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    googleKey,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
}

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
  googleKey = pair.privateKey;
  googleJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  pglite = new PGlite();
  db = drizzle({ client: pglite, schema: coreSchema }) as unknown as CoreDb;
  await migrate(db);
  const app = createApp({
    db,
    resolveToken: createTokenResolver(db),
    electricUrl: "http://electric.test",
    mailer: mail,
    llm: { upstreamUrl: "http://llm.test", upstreamApiKey: "sk-core", defaultModel: "gpt-real" },
    googleClientIds: [GOOGLE_CLIENT],
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.host === "www.googleapis.com") {
        return Response.json({
          keys: [{ ...googleJwk, kid: "test-key", alg: "RS256", use: "sig" }],
        });
      }
      if (url.host === "electric.test") {
        return Response.json([{ headers: { control: "up-to-date" } }], {
          headers: { "electric-handle": "h1", "electric-offset": "0_0", "electric-up-to-date": "" },
        });
      }
      const body = JSON.parse(String(init?.body));
      upstream.push({ model: body.model, auth: new Headers(init?.headers).get("authorization") });
      if (scriptedUpstream) return scriptedUpstream(body);
      return new Response(new Blob(SSE).stream(), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  core = Bun.serve({ port: 0, fetch: app.fetch });
  coreUrl = `http://127.0.0.1:${core.port}`;
}, 60_000);
afterAll(async () => {
  core.stop(true);
  await pglite.close();
});

let dir: string;
let orion: OrionApp | null = null;
let client: OrionClient | null = null;

beforeEach(async () => {
  upstream = [];
  scriptedUpstream = null;
  dir = tempDir();
  await db.execute(
    sql`TRUNCATE farms, animals, devices, device_bindings, connectors, observations, cameras, api_tokens, farm_budgets, llm_usage, farm_invites, farm_members, user_sessions, email_tokens, login_failures, farm_subscriptions, billing_customers, users CASCADE`,
  );
});
afterEach(async () => {
  client?.close();
  await orion?.stop();
  orion = null;
  client = null;
  removeDir(dir);
});

async function boot(extra: Partial<OrionConfig> = {}): Promise<OrionClient> {
  orion = await startOrion({
    port: 0,
    token: TOKEN,
    dataDir: dir,
    mockModel: false,
    seed: true,
    gatewayUrl: null,
    appSource: null,
    coreUrl,
    ...extra,
  });
  client = await connect(orion);
  return client;
}

async function coreCall<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const res = await fetch(`${coreUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await res.json()) as T;
}

async function verifyEmail(email: string) {
  const message = mail.sent.findLast((m) => m.to === email && m.template === "verify_email");
  const token = /verify=([\w-]+)/.exec(message?.text ?? "")?.[1];
  await coreCall("POST", "/v1/auth/verify-email", { token });
}

const newAnimal = { species: "cattle" as const, name: "Skybert", earTagNumber: "7001" };

describe("Orion account", () => {
  test("signed out, Orbit stays local: writes work and sync is disabled", async () => {
    const c = await boot();
    expect(await c.request("account.status", {})).toMatchObject({
      state: "signed_out",
      coreUrl,
      user: null,
    });
    const res = await c.request("db.mutate", {
      mutation: "animals.upsert",
      params: { animal: newAnimal },
    });
    expect(res.ids).toHaveLength(1);
    expect((await db.select().from(pg.animals)).length).toBe(0);
  });

  test("register leaves the farm on this PC; farms.create puts it in the cloud, syncs writes and a paid plan runs on the cloud model", async () => {
    const c = await boot();
    const farmId = c.server?.farmId as string;
    const status = await c.request("account.register", {
      email: "kari@farm.test",
      password: PASSWORD,
      name: "Kari",
      acceptTerms: true,
    });
    expect(status).toMatchObject({
      state: "signed_in",
      user: { email: "kari@farm.test" },
      farm: null,
      farms: [],
      localFarm: { id: farmId },
    });
    expect(await db.select().from(pg.farms)).toEqual([]);
    expect(await db.select().from(farmMembers)).toEqual([]);

    const upToDate = waitFor(c, "sync.status", (s) => s.state === "up_to_date");
    const shared = await c.request("farms.create", { name: "Hill farm" });
    expect(shared).toMatchObject({
      farm: { id: farmId, name: "Hill farm", role: "owner" },
      farms: [{ id: farmId, role: "owner" }],
      localFarm: null,
    });
    await upToDate;

    const pushed = waitFor(
      c,
      "sync.status",
      (s) => s.state === "up_to_date" && s.pendingOutbox === 0,
    );
    const { ids } = await c.request("db.mutate", {
      mutation: "animals.upsert",
      params: { animal: newAnimal },
    });
    await pushed;
    const [cloud] = await db
      .select()
      .from(pg.animals)
      .where(eq(pg.animals.id, ids[0] as string));
    expect(cloud).toMatchObject({ name: "Skybert", farmId });

    await db.execute(sql`
      INSERT INTO farm_subscriptions
        (farm_id, plan, interval, status, stripe_subscription_id, current_period_end, cancel_at_period_end)
      VALUES (${farmId}, 'cam2', 'month', 'active', 'sub_test_1', now() + interval '30 days', false)
    `);
    const settings = await c.request("settings.get", {});
    expect(settings).toMatchObject({ provider: "orbit-gateway", model: "orbit-default" });
    const { session } = await c.request("sessions.create", {});
    const settled = waitFor(c, "agent.settled", (e) => e.sessionId === session.id, 15_000);
    const reply = waitFor(
      c,
      "message.end",
      (e) => e.sessionId === session.id && e.item.kind === "assistant",
      15_000,
    );
    // The conversation's title is asked of the gateway too, beside the answer.
    const named = waitFor(
      c,
      "session.updated",
      (e) => e.sessionId === session.id && e.session.title === "Hello from the cloud",
      15_000,
    );
    await c.request("chat.prompt", { sessionId: session.id, text: "How is the herd?" });
    expect((await reply).item.text).toBe("Hello from the cloud");
    expect((await settled).reason).toBe("completed");
    await named;
    const call = { model: "gpt-real", auth: "Bearer sk-core" };
    expect(upstream).toEqual([call, call]);
    expect(await db.select().from(llmUsage)).toMatchObject([
      { farmId, totalTokens: 15 },
      { farmId, totalTokens: 15 },
    ]);
  });

  test("an invited viewer is refused local writes and stays signed in across restarts", async () => {
    let c = await boot();
    const farmId = c.server?.farmId as string;
    const owner = await coreCall<{ session: { token: string } }>("POST", "/v1/auth/register", {
      email: "owner@farm.test",
      password: PASSWORD,
      acceptTerms: true,
    });
    await coreCall("POST", "/v1/farms", { id: farmId, name: "Hill farm" }, owner.session.token);
    const { code } = await coreCall<{ code: string }>(
      "POST",
      `/v1/farms/${farmId}/invites`,
      { email: "ola@farm.test", role: "viewer" },
      owner.session.token,
    );

    const unlinked = await c.request("account.register", {
      email: "ola@farm.test",
      password: PASSWORD,
      acceptTerms: true,
    });
    expect(unlinked).toMatchObject({ state: "signed_in", farm: null, farms: [] });
    expect(unlinked.linkError).toBeUndefined();

    expect(unlinked.user?.emailVerified).toBe(false);
    await verifyEmail("ola@farm.test");
    expect((await c.request("account.refresh", {})).user?.emailVerified).toBe(true);
    const linked = await c.request("account.acceptInvite", { code });
    const { farm: localFarm } = (await c.request("db.query", { query: "farm.summary" })) as {
      farm: { name: string };
    };
    expect(linked.farm).toEqual({ id: farmId, name: localFarm.name, role: "viewer" });
    const refused = await c
      .request("db.mutate", { mutation: "animals.upsert", params: { animal: newAnimal } })
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "forbidden" });
    const team = await c.request("members.list", {});
    expect(team.members.map((m) => [m.email, m.role])).toEqual([
      ["owner@farm.test", "owner"],
      ["ola@farm.test", "viewer"],
    ]);
    expect(team.invites).toEqual([]);

    client?.close();
    await orion?.stop();
    c = await boot();
    expect(await c.request("account.status", {})).toMatchObject({
      state: "signed_in",
      user: { email: "ola@farm.test" },
      farm: { id: farmId, role: "viewer" },
    });
    const out = await c.request("account.logout", {});
    expect(out).toMatchObject({ state: "signed_out", user: null, farm: null });
    const local = await c.request("db.mutate", {
      mutation: "animals.upsert",
      params: { animal: newAnimal },
    });
    expect(local.ids).toHaveLength(1);
  });

  test("the sign-in lives in the data folder, survives losing the keychain, and moves an old keychain one there", async () => {
    let c = await boot();
    await c.request("account.register", {
      email: "kari@farm.test",
      password: PASSWORD,
      acceptTerms: true,
    });
    const restart = async () => {
      client?.close();
      await orion?.stop();
      c = await boot();
      return c.request("account.status", {});
    };
    // Tests run the secret store as secrets.enc.json; it stands in for the OS keychain here.
    const keychain = () => new EncryptedFileStore(dir);
    const dataFolder = () => new EncryptedFileStore(dir, "account-session.enc.json");
    const token = await dataFolder().get("core-session");
    expect(token).toStartWith("orb_s_");
    expect(await keychain().get("core-session")).toBeNull();

    client?.close();
    await orion?.stop();
    rmSync(join(dir, "secrets.enc.json"), { force: true });
    c = await boot();
    expect(await c.request("account.status", {})).toMatchObject({
      state: "signed_in",
      user: { email: "kari@farm.test" },
    });

    // An Orbit from before this change kept the token in the keychain only.
    client?.close();
    await orion?.stop();
    await dataFolder().delete("core-session");
    await keychain().set("core-session", token as string);
    c = await boot();
    expect(await c.request("account.status", {})).toMatchObject({ state: "signed_in" });
    expect(await dataFolder().get("core-session")).toBe(token);
    expect(await keychain().get("core-session")).toBeNull();

    await c.request("account.logout", {});
    expect(await dataFolder().get("core-session")).toBeNull();
    expect(await restart()).toMatchObject({ state: "signed_out", user: null });
  });

  test("Google sign-in runs on the website and comes back through Orion's own page, once", async () => {
    const c = await boot();
    const start = async () => {
      const { url, opened } = await c.request("account.googleStart", {});
      expect(opened).toBe(false);
      const site = new URL(url);
      expect(`${site.origin}${site.pathname}`).toBe("https://pecorva.com/account/app/");
      return new URL(site.searchParams.get("callback") as string);
    };
    const post = (callback: URL, body: unknown, origin = callback.origin) =>
      fetch(callback, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const rejected = await start();
    expect(rejected.origin).toBe(`http://127.0.0.1:${orion?.port}`);
    const refused = await post(rejected, { credential: "not.a.token" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      ok: false,
      message: "invalid Google sign-in token",
    });

    const callback = await start();
    const pageRes = await fetch(callback);
    expect(pageRes.status).toBe(200);
    expect(pageRes.headers.get("content-security-policy")).toContain("script-src 'nonce-");
    expect(
      (await post(callback, { credential: await googleCredential() }, "https://evil.test")).status,
    ).toBe(403);

    const updated = waitFor(c, "account.updated", (s) => s.state === "signed_in");
    const ok = await post(callback, { credential: await googleCredential() });
    expect(await ok.json()).toEqual({ ok: true, email: "google@farm.test" });
    expect((await updated).user?.email).toBe("google@farm.test");
    expect(await c.request("account.status", {})).toMatchObject({
      state: "signed_in",
      farm: null,
    });

    expect((await post(callback, { credential: await googleCredential() })).status).toBe(410);
    expect((await fetch(callback)).status).toBe(410);
    expect((await fetch(new URL(`/account/google/${"x".repeat(32)}`, callback))).status).toBe(410);
  });

  test("a plan bought on the website before Orbit was installed follows the account into Orbit", async () => {
    const buyer = await coreCall<{ session: { token: string } }>("POST", "/v1/auth/register", {
      email: "kari@farm.test",
      password: PASSWORD,
      acceptTerms: true,
    });
    const { farm } = await coreCall<{ farm: { id: string } }>(
      "POST",
      "/v1/farms",
      { name: "Website farm" },
      buyer.session.token,
    );
    await db.execute(sql`
      INSERT INTO farm_subscriptions (farm_id, plan, interval, status)
      VALUES (${farm.id}, 'cam2', 'month', 'active')
    `);

    const c = await boot();
    const localFarmId = c.server?.farmId as string;
    expect(localFarmId).not.toBe(farm.id);
    const status = await c.request("account.login", {
      email: "kari@farm.test",
      password: PASSWORD,
    });
    expect(status).toMatchObject({
      state: "signed_in",
      farm: null,
      farms: [{ id: farm.id, name: "Website farm", role: "owner" }],
    });
    const upToDate = waitFor(c, "sync.status", (s) => s.state === "up_to_date");
    const shared = await c.request("farms.create", {});
    expect(shared).toMatchObject({ farm: { id: localFarmId, role: "owner" } });
    await upToDate;
    expect(await c.request("billing.status", {})).toMatchObject({ plan: "cam2", status: "active" });

    const { session } = await c.request("sessions.create", {});
    const reply = waitFor(
      c,
      "message.end",
      (e) => e.sessionId === session.id && e.item.kind === "assistant",
      15_000,
    );
    const settled = waitFor(c, "agent.settled", (e) => e.sessionId === session.id, 15_000);
    // The conversation's title is asked of the gateway too, beside the answer.
    const named = waitFor(
      c,
      "session.updated",
      (e) => e.sessionId === session.id && e.session.title === "Hello from the cloud",
      15_000,
    );
    await c.request("chat.prompt", { sessionId: session.id, text: "How is the herd?" });
    expect((await reply).item.text).toBe("Hello from the cloud");
    expect((await settled).reason).toBe("completed");
    await named;
    expect(await db.select().from(llmUsage)).toMatchObject([
      { farmId: localFarmId },
      { farmId: localFarmId },
    ]);
  });

  test("Gemini thought signatures on tool calls go back to the model on the next turn", async () => {
    const sse = (chunks: object[]) =>
      new Response(
        new Blob([
          ...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`),
          "data: [DONE]\n\n",
        ]).stream(),
        { headers: { "content-type": "text/event-stream" } },
      );
    const followUps: unknown[] = [];
    scriptedUpstream = (body) => {
      const toolTurn = body.messages.find((m) => m.role === "assistant" && m.tool_calls);
      if (!toolTurn) {
        return sse([
          {
            id: "g1",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-1",
                      type: "function",
                      function: { name: "herd_query", arguments: "{}" },
                      extra_content: { google: { thought_signature: "sig-from-gemini" } },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: "g1",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          },
        ]);
      }
      followUps.push((toolTurn.tool_calls as Record<string, unknown>[])[0]);
      // Gemini rejects a replayed tool call without its signature, exactly like this.
      const signed = (
        toolTurn.tool_calls as { extra_content?: { google?: { thought_signature?: string } } }[]
      )[0]?.extra_content?.google?.thought_signature;
      if (signed !== "sig-from-gemini") {
        return Response.json(
          { error: { message: "Function call is missing a thought_signature" } },
          { status: 400 },
        );
      }
      return sse([
        {
          id: "g2",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "28 animals, 4 pregnant" },
              finish_reason: null,
            },
          ],
        },
        {
          id: "g2",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 9, completion_tokens: 6 },
        },
      ]);
    };
    const c = await boot();
    const farmId = c.server?.farmId as string;
    await c.request("account.register", {
      email: "kari@farm.test",
      password: PASSWORD,
      acceptTerms: true,
    });
    await c.request("farms.create", {});
    await db.execute(sql`
      INSERT INTO farm_subscriptions (farm_id, plan, interval, status)
      VALUES (${farmId}, 'cam2', 'month', 'active')
    `);
    const { session } = await c.request("sessions.create", {});
    const reply = waitFor(
      c,
      "message.end",
      (e) => e.sessionId === session.id && e.item.kind === "assistant" && e.item.text.length > 0,
      15_000,
    );
    const settled = waitFor(c, "agent.settled", (e) => e.sessionId === session.id, 15_000);
    await c.request("chat.prompt", {
      sessionId: session.id,
      text: "How many animals, and which are pregnant?",
    });
    expect((await reply).item.text).toBe("28 animals, 4 pregnant");
    expect((await settled).reason).toBe("completed");
    expect(followUps).toMatchObject([
      { id: "call-1", extra_content: { google: { thought_signature: "sig-from-gemini" } } },
    ]);
  });

  test("a farm on the free month shares a page through Orion, and Core holds it for review", async () => {
    const reply = (chunks: object[]) =>
      new Response(
        new Blob([
          ...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`),
          "data: [DONE]\n\n",
        ]).stream(),
        { headers: { "content-type": "text/event-stream" } },
      );
    scriptedUpstream = (body) => {
      if (body.messages.some((m) => m.role === "assistant" && m.tool_calls)) {
        return reply([
          { id: "s2", choices: [{ index: 0, delta: { role: "assistant", content: "Shared." } }] },
          { id: "s2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      }
      return reply([
        {
          id: "s1",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call-share",
                    type: "function",
                    function: {
                      name: "share_build",
                      arguments: JSON.stringify({
                        kind: "page",
                        name: "morning-round",
                        title: "Morning round",
                        description: "A checklist for the first walk through the barn.",
                      }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { id: "s1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ]);
    };
    const c = await boot();
    await c.request("account.register", {
      email: "kari@farm.test",
      password: PASSWORD,
      acceptTerms: true,
    });
    await verifyEmail("kari@farm.test");
    await c.request("account.refresh", {});
    const page = join(dir, "workspace", "pages", "morning-round");
    mkdirSync(page, { recursive: true });
    writeFileSync(join(page, "index.html"), "<h1>Morning round</h1>");

    const { session } = await c.request("sessions.create", {});
    const settled = waitFor(c, "agent.settled", (e) => e.sessionId === session.id, 15_000);
    await c.request("chat.prompt", { sessionId: session.id, text: "Share the morning round page" });
    expect((await settled).reason).toBe("completed");

    const { submissions } = await c.request("shared.list", {});
    expect(submissions).toMatchObject([
      { kind: "page", name: "morning-round", title: "Morning round", status: "pending" },
    ]);
    const stored = (await db.execute(sql`SELECT files FROM submissions`)) as { rows: unknown[] };
    expect(stored.rows).toEqual([
      { files: [{ path: "index.html", content: "<h1>Morning round</h1>" }] },
    ]);
  });

  test("a member runs on their own plan until the owner allows the farm plan, then switches", async () => {
    const c = await boot();
    const farmId = c.server?.farmId as string;
    const owner = await coreCall<{ session: { token: string } }>("POST", "/v1/auth/register", {
      email: "owner@farm.test",
      password: PASSWORD,
      acceptTerms: true,
    });
    await coreCall("POST", "/v1/farms", { id: farmId, name: "Hill farm" }, owner.session.token);
    await db.execute(sql`
      INSERT INTO farm_subscriptions (farm_id, plan, interval, status)
      VALUES (${farmId}, 'cam2', 'month', 'active')
    `);
    const { code } = await coreCall<{ code: string }>(
      "POST",
      `/v1/farms/${farmId}/invites`,
      { email: "kari@farm.test", role: "worker" },
      owner.session.token,
    );
    const signedIn = await c.request("account.register", {
      email: "kari@farm.test",
      password: PASSWORD,
      acceptTerms: true,
    });
    const kari = signedIn.user?.id as string;
    await verifyEmail("kari@farm.test");
    await c.request("account.refresh", {});
    expect(await c.request("account.acceptInvite", { code })).toMatchObject({
      farm: { id: farmId, role: "worker" },
    });

    const ask = async (text: string) => {
      const { session } = await c.request("sessions.create", { title: text });
      const settled = waitFor(c, "agent.settled", (e) => e.sessionId === session.id, 15_000);
      await c.request("chat.prompt", { sessionId: session.id, text });
      expect((await settled).reason).toBe("completed");
    };
    expect(await c.request("billing.status", {})).toMatchObject({
      account: "personal",
      farmPlanAllowed: false,
      farm: { plan: "cam2" },
    });
    await ask("On my own plan");
    expect(
      (await db.select().from(llmUsage)).every((u) => u.accountId === kari && u.userId === kari),
    ).toBe(true);

    await coreCall(
      "PATCH",
      `/v1/farms/${farmId}/members/${kari}`,
      { useFarmPlan: true },
      owner.session.token,
    );
    expect(await c.request("billing.setSource", { source: "farm" })).toMatchObject({
      account: "farm",
      plan: "cam2",
      usageSource: "farm",
      farmPlanAllowed: true,
    });
    await db.delete(llmUsage);
    await ask("On the farm plan");
    const rows = await db.select().from(llmUsage);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((u) => u.accountId === farmId && u.userId === kari)).toBe(true);
    const { members } = await c.request("members.list", {});
    expect(members.find((m) => m.userId === kari)).toMatchObject({
      useFarmPlan: true,
      usageSource: "farm",
      usage: { farmTokens: rows.reduce((n, u) => n + u.totalTokens, 0), ownTokens: 0 },
    });
  });

  test("each person on this PC sees only their own chats", async () => {
    const c = await boot();
    const titles = async () =>
      (await c.request("sessions.list", {})).sessions.map((s) => s.title).sort();
    await c.request("sessions.create", { title: "Before signing in" });

    // The first person to sign in keeps the chats made before accounts.
    const toKari = waitFor(c, "sessions.reset", () => true);
    await c.request("account.register", {
      email: "kari@farm.test",
      password: PASSWORD,
      acceptTerms: true,
    });
    await toKari;
    expect(await titles()).toEqual(["Before signing in"]);
    await c.request("sessions.create", { title: "Kari's" });

    await c.request("account.logout", {});
    expect(await titles()).toEqual([]);
    await c.request("account.register", {
      email: "ola@farm.test",
      password: PASSWORD,
      acceptTerms: true,
    });
    expect(await titles()).toEqual([]);
    await c.request("sessions.create", { title: "Ola's" });
    await c.request("account.logout", {});

    await c.request("account.login", { email: "kari@farm.test", password: PASSWORD });
    expect(await titles()).toEqual(["Before signing in", "Kari's"]);
    client?.close();
    await orion?.stop();
    const again = await boot();
    expect((await again.request("sessions.list", {})).sessions.map((s) => s.title).sort()).toEqual([
      "Before signing in",
      "Kari's",
    ]);
  });

  test("a member opens another farm in its own folder and goes back to this PC's farm", async () => {
    const owner = await coreCall<{ session: { token: string } }>("POST", "/v1/auth/register", {
      email: "owner@farm.test",
      password: PASSWORD,
      acceptTerms: true,
    });
    const { farm: hill } = await coreCall<{ farm: { id: string } }>(
      "POST",
      "/v1/farms",
      { name: "Hill farm" },
      owner.session.token,
    );
    const { code } = await coreCall<{ code: string }>(
      "POST",
      `/v1/farms/${hill.id}/invites`,
      { email: "kari@farm.test", role: "worker" },
      owner.session.token,
    );

    let reopened = Promise.withResolvers<void>();
    const reopen = () => reopened.resolve();
    let c = await boot({ reopen });
    const ownFarm = c.server?.farmId as string;
    await c.request("account.register", {
      email: "kari@farm.test",
      password: PASSWORD,
      acceptTerms: true,
    });
    await verifyEmail("kari@farm.test");
    await c.request("account.refresh", {});
    const joined = await c.request("account.acceptInvite", { code });
    expect(joined).toMatchObject({
      farm: null,
      farms: [{ id: hill.id, name: "Hill farm", role: "worker" }],
      localFarm: { id: ownFarm },
    });
    await c.request("sessions.create", { title: "On my own farm" });

    expect(await c.request("farms.open", { farmId: hill.id })).toEqual({ restarting: true });
    await reopened.promise;
    client?.close();
    await orion?.stop();
    reopened = Promise.withResolvers<void>();
    c = await boot({ reopen });
    expect(c.server?.farmId).toBe(hill.id);
    expect(await c.request("account.status", {})).toMatchObject({
      farm: { id: hill.id, role: "worker" },
      localFarm: { id: ownFarm },
    });
    expect(existsSync(join(dir, "farms", hill.id, "orbit.sqlite"))).toBe(true);
    expect((await c.request("sessions.list", {})).sessions).toEqual([]);
    // Open again: nothing to do.
    expect(await c.request("farms.open", { farmId: hill.id })).toEqual({ restarting: false });
    const stranger = await c
      .request("farms.open", { farmId: crypto.randomUUID() })
      .catch((e: unknown) => e);
    expect(stranger).toMatchObject({ code: "not_found" });

    expect(await c.request("farms.open", { farmId: "local" })).toEqual({ restarting: true });
    await reopened.promise;
    client?.close();
    await orion?.stop();
    c = await boot({ reopen });
    expect(c.server?.farmId).toBe(ownFarm);
    expect((await c.request("sessions.list", {})).sessions.map((s) => s.title)).toEqual([
      "On my own farm",
    ]);
  });
});
