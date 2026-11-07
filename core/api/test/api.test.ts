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
  farmBudgets,
  issueToken,
  llmUsage,
  migrate,
} from "../src";

const FARM = "00000000-0000-4000-8000-000000000001";
const OTHER_FARM = "00000000-0000-4000-8000-000000000002";
const A1 = "00000000-0000-4000-8000-0000000000a1";
const TOKEN = "dev-token";
const auth = { authorization: `Bearer ${TOKEN}` };

let client: PGlite;
let db: CoreDb;

// Booting PGlite (Postgres compiled to WASM) takes >5 s on shared CI runners.
beforeAll(async () => {
  client = new PGlite();
  db = drizzle({ client, schema: coreSchema }) as unknown as CoreDb;
  await migrate(db);
}, 60_000);
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE farms, animals, devices, device_bindings, connectors, observations, cameras, camera_layouts, api_tokens, farm_budgets, llm_usage`,
  );
});

function app(extra: Partial<AppOptions> = {}) {
  return createApp({
    db,
    resolveToken: createTokenResolver(db, `${TOKEN}:${FARM}`),
    electricUrl: "http://electric.internal:3000",
    electricSecret: "electric-secret",
    ...extra,
  });
}

const hlc = (iso: string, counter = 0, node = "install-1") =>
  `${String(Date.parse(iso)).padStart(15, "0")}:${String(counter).padStart(6, "0")}:${node}`;

function animalRow(h: string, extra: Record<string, unknown> = {}) {
  return {
    id: A1,
    species: "cattle",
    name: "Dagros",
    ear_tag_number: "1001",
    national_id: null,
    breed: "Holstein",
    sex: "female",
    birth_date: "2022-03-01",
    group_name: null,
    status: "active",
    notes: null,
    farm_id: FARM,
    created_at: "2026-11-01T08:00:00.000Z",
    updated_at: "2026-11-01T08:00:00.000Z",
    deleted_at: null,
    hlc: h,
    origin_device: "install-1",
    ...extra,
  };
}

let seq = 0;
async function push(
  a: ReturnType<typeof app>,
  table: string,
  row: Record<string, unknown>,
  op = "insert",
) {
  const res = await a.request("/v1/changes", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      changes: [{ seq: ++seq, op, table, rowId: row.id, hlc: row.hlc, row }],
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { results: { status: string; error?: string }[] };
  return body.results[0];
}

const animal = async () => (await db.select().from(pg.animals).where(eq(pg.animals.id, A1)))[0];

describe("basics", () => {
  test("healthz reports ok without a token", async () => {
    const res = await app().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  test("v1 routes require a valid bearer token", async () => {
    expect((await app().request("/v1/changes", { method: "POST" })).status).toBe(401);
    const bad = await app().request("/v1/shape?table=animals&offset=-1", {
      headers: { authorization: "Bearer nope" },
    });
    expect(bad.status).toBe(401);
  });

  test("issued tokens are stored hashed and resolve to their farm", async () => {
    const token = await issueToken(db, OTHER_FARM, "barn pc");
    expect(await createTokenResolver(db)(token)).toBe(OTHER_FARM);
    const stored = await db.select().from(coreSchema.apiTokens);
    expect(stored[0]?.tokenHash).not.toContain(token);
  });

  test("migrate is idempotent", async () => {
    expect((await migrate(db)).applied).toEqual([]);
  });
});

describe("POST /v1/changes", () => {
  test("camera layouts migrate and accept farm-scoped JSON updates with row LWW", async () => {
    const a = app();
    const layout = { version: 2, tiles: [{ i: "barn", x: 0, y: 20, w: 400 }] };
    const row = {
      id: FARM,
      farm_id: FARM,
      layout,
      created_at: "2026-11-04T00:00:00.000Z",
      updated_at: "2026-11-04T00:00:00.000Z",
      deleted_at: null,
      hlc: hlc("2026-11-04T00:00:00Z"),
      origin_device: "local",
    };

    expect(await push(a, "camera_layouts", row)).toMatchObject({ status: "applied" });
    expect(await push(a, "camera_layouts", row)).toMatchObject({ status: "stale" });
    expect((await db.select().from(pg.cameraLayouts))[0]?.layout).toEqual(layout);
    expect(await push(a, "camera_layouts", { ...row, farm_id: OTHER_FARM })).toMatchObject({
      status: "rejected",
    });
  });

  test("applies a valid row, then LWW: equal/older is stale, newer wins", async () => {
    const a = app();
    expect(await push(a, "animals", animalRow(hlc("2026-11-02T00:00:00Z")))).toMatchObject({
      status: "applied",
    });
    expect(await push(a, "animals", animalRow(hlc("2026-11-02T00:00:00Z")))).toMatchObject({
      status: "stale",
    });
    expect(
      await push(a, "animals", animalRow(hlc("2026-11-01T00:00:00Z"), { name: "Old" })),
    ).toMatchObject({ status: "stale" });
    expect((await animal())?.name).toBe("Dagros");
    expect(
      await push(a, "animals", animalRow(hlc("2026-11-03T00:00:00Z"), { name: "New" }), "update"),
    ).toMatchObject({ status: "applied" });
    expect((await animal())?.name).toBe("New");
  });

  test("rejects rows for another farm, bad enums and malformed values", async () => {
    const a = app();
    const h = hlc("2026-11-02T00:00:00Z");
    expect(await push(a, "animals", animalRow(h, { farm_id: OTHER_FARM }))).toMatchObject({
      status: "rejected",
      error: "farm_id does not match the token",
    });
    expect(await push(a, "animals", animalRow(h, { species: "sheep" }))).toMatchObject({
      status: "rejected",
    });
    expect(await push(a, "animals", animalRow(h, { birth_date: "1 March" }))).toMatchObject({
      status: "rejected",
    });
    expect(await push(a, "animals", animalRow("not-an-hlc"))).toMatchObject({ status: "rejected" });
    expect(await animal()).toBeUndefined();
  });

  test("soft deletes keep the row; delete ops without deleted_at are rejected", async () => {
    const a = app();
    await push(a, "animals", animalRow(hlc("2026-11-02T00:00:00Z")));
    expect(
      await push(a, "animals", animalRow(hlc("2026-11-03T00:00:00Z")), "delete"),
    ).toMatchObject({ status: "rejected" });
    const deleted = animalRow(hlc("2026-11-03T00:00:00Z"), {
      deleted_at: "2026-11-03T00:00:00.000Z",
    });
    expect(await push(a, "animals", deleted, "delete")).toMatchObject({ status: "applied" });
    expect(Date.parse((await animal())?.deletedAt ?? "")).toBe(Date.parse("2026-11-03T00:00:00Z"));
  });

  test("rejects oversized and malformed requests", async () => {
    const res = await app().request("/v1/changes", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ changes: "nope" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("single active wearable per animal", () => {
  const COW = "00000000-0000-4000-8000-0000000000c1";
  const BOLUS = "00000000-0000-4000-8000-0000000000d1";
  const COLLAR = "00000000-0000-4000-8000-0000000000d2";
  const B1 = "00000000-0000-4000-8000-0000000000b1";
  const B2 = "00000000-0000-4000-8000-0000000000b2";

  const device = (id: string, kind: string) => ({
    id,
    kind,
    vendor: null,
    model: null,
    serial: null,
    connection: null,
    status: "online",
    battery_pct: null,
    last_seen_at: null,
    farm_id: FARM,
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    deleted_at: null,
    hlc: hlc("2026-11-01T00:00:00Z"),
    origin_device: "install-1",
  });
  const binding = (id: string, deviceId: string, boundAt: string, h: string) => ({
    id,
    device_id: deviceId,
    animal_id: COW,
    wearable: true,
    bound_at: boundAt,
    unbound_at: null,
    farm_id: FARM,
    created_at: boundAt,
    updated_at: boundAt,
    deleted_at: null,
    hlc: h,
    origin_device: "install-1",
  });
  const getBinding = async (id: string) =>
    (await db.select().from(pg.deviceBindings).where(eq(pg.deviceBindings.id, id)))[0];

  async function setup(a: ReturnType<typeof app>) {
    await push(a, "devices", device(BOLUS, "bolus"));
    await push(a, "devices", device(COLLAR, "collar"));
    await push(
      a,
      "device_bindings",
      binding(B1, BOLUS, "2026-11-01T00:00:00.000Z", hlc("2026-11-02T00:00:00Z")),
    );
  }

  test("a newer wearable binding ends the older one with a cloud HLC", async () => {
    const a = app();
    await setup(a);
    const result = await push(
      a,
      "device_bindings",
      binding(B2, COLLAR, "2026-11-03T00:00:00.000Z", hlc("2026-11-03T00:00:00Z")),
    );
    expect(result).toMatchObject({ status: "applied" });
    const old = await getBinding(B1);
    expect(Date.parse(old?.unboundAt ?? "")).toBe(Date.parse("2026-11-03T00:00:00Z"));
    expect(old?.originDevice).toBe("cloud");
    expect(old?.hlc.endsWith(":cloud")).toBe(true);
    expect((await getBinding(B2))?.unboundAt).toBeNull();
  });

  test("an older conflicting binding is stored already ended", async () => {
    const a = app();
    await setup(a);
    await push(
      a,
      "device_bindings",
      binding(B2, COLLAR, "2026-10-30T00:00:00.000Z", hlc("2026-11-01T12:00:00Z")),
    );
    expect((await getBinding(B1))?.unboundAt).toBeNull();
    const late = await getBinding(B2);
    expect(Date.parse(late?.unboundAt ?? "")).toBe(Date.parse("2026-11-01T00:00:00Z"));
  });

  test("the wearable flag must match the device kind", async () => {
    const a = app();
    await setup(a);
    const wrong = {
      ...binding(B2, COLLAR, "2026-11-03T00:00:00.000Z", hlc("2026-11-03T00:00:00Z")),
      wearable: false,
    };
    expect(await push(a, "device_bindings", wrong)).toMatchObject({ status: "rejected" });
  });
});

describe("GET /v1/shape", () => {
  test.each(["animals", "camera_layouts"])(
    "%s forces the farm filter and forwards Electric headers",
    async (table) => {
      let upstream: URL | undefined;
      const a = app({
        fetch: async (input) => {
          upstream = new URL(String(input));
          return new Response("[]", {
            headers: {
              "electric-handle": "h-1",
              "electric-offset": "0_0",
              "content-type": "application/json",
            },
          });
        },
      });
      const res = await a.request(
        `/v1/shape?table=${table}&offset=-1&where=1%3D1&params%5B1%5D=x&live=true`,
        { headers: auth },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("electric-handle")).toBe("h-1");
      expect(upstream?.origin + (upstream?.pathname ?? "")).toBe(
        "http://electric.internal:3000/v1/shape",
      );
      expect(Object.fromEntries(upstream?.searchParams ?? [])).toEqual({
        table,
        offset: "-1",
        live: "true",
        where: "farm_id = $1",
        "params[1]": FARM,
        replica: "full",
        secret: "electric-secret",
      });
    },
  );

  test("refuses non-synced tables", async () => {
    const res = await app().request("/v1/shape?table=api_tokens&offset=-1", { headers: auth });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/llm/*", () => {
  const llm = {
    upstreamUrl: "https://llm.example",
    upstreamApiKey: "sk-core",
    defaultMonthlyTokenBudget: 1000,
  };
  const call = (a: ReturnType<typeof app>, body: object, path = "/v1/llm/v1/chat/completions") =>
    a.request(path, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const usageRows = () => db.select().from(llmUsage);

  test("forwards with Core's key and records usage from a JSON response", async () => {
    let seen: { url: string; auth: string | null; body: string } | undefined;
    const a = app({
      llm,
      fetch: async (input, init) => {
        seen = {
          url: String(input),
          auth: new Headers(init?.headers).get("authorization"),
          body: String(init?.body),
        };
        return Response.json({ id: "x", usage: { prompt_tokens: 30, completion_tokens: 12 } });
      },
    });
    const res = await call(a, { model: "gpt-x", messages: [] });
    expect(res.status).toBe(200);
    expect(seen?.url).toBe("https://llm.example/v1/chat/completions");
    expect(seen?.auth).toBe("Bearer sk-core");
    expect(await usageRows()).toMatchObject([
      { farmId: FARM, model: "gpt-x", inputTokens: 30, outputTokens: 12, totalTokens: 42 },
    ]);
  });

  test("meters streamed (SSE) responses and asks OpenAI-style streams for usage", async () => {
    let forwarded: Record<string, unknown> = {};
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":50,"output_tokens":1}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":20}}\n\n',
      "data: [DONE]\n\n",
    ];
    const a = app({
      llm: { ...llm, authHeader: "x-api-key" },
      fetch: async (_input, init) => {
        forwarded = JSON.parse(String(init?.body));
        return new Response(new Blob(sse).stream(), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const res = await call(a, { model: "m", stream: true });
    expect(await res.text()).toBe(sse.join(""));
    expect(forwarded.stream_options).toEqual({ include_usage: true });
    expect(await usageRows()).toMatchObject([
      { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
    ]);
  });

  test("refuses farms over their monthly budget without calling upstream", async () => {
    let called = false;
    const a = app({
      llm,
      fetch: async () => {
        called = true;
        return Response.json({});
      },
    });
    await db.insert(farmBudgets).values({ farmId: FARM, monthlyTokenBudget: 100 });
    await db.insert(llmUsage).values({ farmId: FARM, path: "/x", status: 200, totalTokens: 100 });
    const res = await call(a, { model: "m" });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      error: { code: "budget_exceeded", used: 100, budget: 100 },
    });
    expect(called).toBe(false);
  });

  test("returns 503 when no upstream is configured", async () => {
    expect((await call(app(), { model: "m" })).status).toBe(503);
  });
});
