// Orion against a real in-process Core (createApp + PGlite on a live port): sign-in, farm linking,
// sync, the cloud model and local role enforcement. Electric and the LLM provider are faked at
// Core's upstream fetch.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  type CoreDb,
  coreSchema,
  createApp,
  createLogMailer,
  createTokenResolver,
  llmUsage,
  migrate,
} from "@core/api";
import { PGlite } from "@electric-sql/pglite";
import type { OrionClient } from "@orbit/protocol/client";
import { pg } from "@orbit/schema";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { type OrionApp, startOrion } from "../src/app";
import { connect, removeDir, TOKEN, tempDir, waitFor } from "./helpers";

const PASSWORD = "correct horse battery";
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
const mail = createLogMailer(() => {});

beforeAll(async () => {
  pglite = new PGlite();
  db = drizzle({ client: pglite, schema: coreSchema }) as unknown as CoreDb;
  await migrate(db);
  const app = createApp({
    db,
    resolveToken: createTokenResolver(db),
    electricUrl: "http://electric.test",
    mailer: mail,
    llm: { upstreamUrl: "http://llm.test", upstreamApiKey: "sk-core", defaultModel: "gpt-real" },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.host === "electric.test") {
        return Response.json([{ headers: { control: "up-to-date" } }], {
          headers: { "electric-handle": "h1", "electric-offset": "0_0", "electric-up-to-date": "" },
        });
      }
      upstream.push({
        model: JSON.parse(String(init?.body)).model,
        auth: new Headers(init?.headers).get("authorization"),
      });
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

async function boot(): Promise<OrionClient> {
  orion = await startOrion({
    port: 0,
    token: TOKEN,
    dataDir: dir,
    mockModel: false,
    seed: true,
    gatewayUrl: null,
    appSource: null,
    coreUrl,
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

  test("register claims the local farm, syncs writes to Core and a paid plan runs on the cloud model", async () => {
    const c = await boot();
    const farmId = c.server?.farmId as string;
    const upToDate = waitFor(c, "sync.status", (s) => s.state === "up_to_date");
    const status = await c.request("account.register", {
      email: "kari@farm.test",
      password: PASSWORD,
      name: "Kari",
      acceptTerms: true,
    });
    expect(status).toMatchObject({
      state: "signed_in",
      user: { email: "kari@farm.test" },
      farm: { id: farmId, role: "owner" },
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
      VALUES (${farmId}, 'pen', 'month', 'active', 'sub_test_1', now() + interval '30 days', false)
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
    await c.request("chat.prompt", { sessionId: session.id, text: "How is the herd?" });
    expect((await reply).item.text).toBe("Hello from the cloud");
    expect((await settled).reason).toBe("completed");
    expect(upstream).toEqual([{ model: "gpt-real", auth: "Bearer sk-core" }]);
    expect(await db.select().from(llmUsage)).toMatchObject([{ farmId, totalTokens: 15 }]);
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
    expect(unlinked).toMatchObject({ state: "signed_in", farm: null });
    expect(unlinked.linkError).toContain("ask one of its owners for an invite");

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
      VALUES (${farm.id}, 'pen', 'month', 'active')
    `);

    const c = await boot();
    const localFarmId = c.server?.farmId as string;
    expect(localFarmId).not.toBe(farm.id);
    const upToDate = waitFor(c, "sync.status", (s) => s.state === "up_to_date");
    const status = await c.request("account.login", {
      email: "kari@farm.test",
      password: PASSWORD,
    });
    expect(status).toMatchObject({ state: "signed_in", farm: { id: localFarmId, role: "owner" } });
    await upToDate;
    expect(await c.request("billing.status", {})).toMatchObject({ plan: "pen", status: "active" });

    const { session } = await c.request("sessions.create", {});
    const reply = waitFor(
      c,
      "message.end",
      (e) => e.sessionId === session.id && e.item.kind === "assistant",
      15_000,
    );
    await c.request("chat.prompt", { sessionId: session.id, text: "How is the herd?" });
    expect((await reply).item.text).toBe("Hello from the cloud");
    expect(await db.select().from(llmUsage)).toMatchObject([{ farmId: localFarmId }]);
  });
});
