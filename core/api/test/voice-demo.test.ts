import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { type AppOptions, type CoreDb, coreSchema, createApp, migrate } from "../src";
import { clientIp, visitorKey } from "../src/voice-demo";

const AGENT = "agent_test123";
const KEY = "xi-test-key";

interface Call {
  url: URL;
  key: string | null;
}

let client: PGlite;
let db: CoreDb;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle({ client, schema: coreSchema }) as unknown as CoreDb;
  await migrate(db);
}, 60_000);
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE voice_demo_sessions`);
});

/** ElevenLabs conversation details as GET /v1/convai/conversations/{id} returns them. */
type Conversation = { status: string; call_duration_secs?: number; agent_id?: string } | 404 | 500;

function setup(
  opts: {
    voiceDemo?: AppOptions["voiceDemo"];
    upstream?: () => Response;
    start?: number;
    conversations?: Map<string, Conversation>;
  } = {},
) {
  const calls: Call[] = [];
  const conversations = opts.conversations ?? new Map<string, Conversation>();
  let clock = opts.start ?? Date.parse("2026-11-09T12:00:00Z");
  let minted = 0;
  const app = createApp({
    db,
    resolveToken: async () => null,
    electricUrl: "http://electric.internal:3000",
    corsOrigins: ["https://pecorva.com", "http://localhost:3000"],
    now: () => new Date(clock),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, key: new Headers(init?.headers).get("xi-api-key") });
      const conv = /^\/v1\/convai\/conversations\/(.+)$/.exec(url.pathname)?.[1];
      if (conv) {
        const found = conversations.get(decodeURIComponent(conv)) ?? 404;
        if (typeof found === "number") return new Response("{}", { status: found });
        return Response.json({
          agent_id: found.agent_id ?? AGENT,
          status: found.status,
          metadata: { call_duration_secs: found.call_duration_secs },
        });
      }
      if (opts.upstream) return opts.upstream();
      const conversation_id = `conv_${++minted}`;
      const body = url.pathname.endsWith("/token")
        ? { token: "tok_abc", conversation_id }
        : {
            signed_url: "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=x&sig=y",
            conversation_id,
          };
      return Response.json(body);
    },
    voiceDemo: { apiKey: KEY, agentId: AGENT, ...opts.voiceDemo },
  });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.request("/v1/voice/demo/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { app, calls, post, conversations, advance: (ms: number) => (clock += ms) };
}

describe("POST /v1/voice/demo/session", () => {
  test("webrtc (default) returns a conversation token", async () => {
    const { calls, post } = setup();
    const res = await post({ voice: "male" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      conversation_token: "tok_abc",
      agent_id: AGENT,
      voice_id: "iP95p4xoKVk53GoZ742B",
      voice_name: "Chris",
      max_seconds: 180,
      allowance_seconds: 180,
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url.origin + (call?.url.pathname ?? "")).toBe(
      "https://api.elevenlabs.io/v1/convai/conversation/token",
    );
    expect(call?.url.searchParams.get("agent_id")).toBe(AGENT);
    expect(call?.key).toBe(KEY);
  });

  test("websocket returns a signed url", async () => {
    const { calls, post } = setup();
    const res = await post({ voice: "female", transport: "websocket" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.signed_url).toStartWith("wss://api.elevenlabs.io/");
    expect(body.conversation_token).toBeUndefined();
    expect(body).toMatchObject({ voice_id: "EXAVITQu4vr4xnSDxMaL", voice_name: "Sarah" });
    const [call] = calls;
    expect(call?.url.pathname).toBe("/v1/convai/conversation/get-signed-url");
    expect(call?.url.searchParams.get("agent_id")).toBe(AGENT);
    // Single-use signed URL bound to a conversation id, so the call can be metered.
    expect(call?.url.searchParams.get("include_conversation_id")).toBe("true");
    expect(call?.key).toBe(KEY);
  });

  test("bad body is 400 without an upstream call", async () => {
    const { calls, post } = setup();
    expect((await post({ voice: "robot" })).status).toBe(400);
    expect((await post({ voice: "male", transport: "sip" })).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("missing key or agent is 503 not_configured", async () => {
    for (const voiceDemo of [{ apiKey: undefined }, { agentId: undefined }]) {
      const { calls, post } = setup({ voiceDemo });
      const res = await post({ voice: "male" });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_configured");
      expect(calls).toHaveLength(0);
    }
  });

  test("upstream failure is 502 and does not leak the upstream body", async () => {
    const { post } = setup({
      upstream: () => new Response('{"detail":"secret upstream detail"}', { status: 401 }),
    });
    const res = await post({ voice: "male" });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("secret upstream detail");
    expect(JSON.parse(text).error.code).toBe("upstream_error");
  });

  test("per-IP limit returns 429 with Retry-After, then recovers after the window", async () => {
    const conversations = new Map<string, Conversation>();
    for (let i = 1; i <= 10; i++)
      conversations.set(`conv_${i}`, { status: "done", call_duration_secs: 5 });
    const { post, advance } = setup({ conversations, voiceDemo: { allowanceSeconds: 1000 } });
    for (let i = 0; i < 5; i++) {
      expect(
        (await post({ voice: "male" }, { "x-forwarded-for": "10.0.0.1, 198.51.100.1" })).status,
      ).toBe(200);
      advance(1000);
    }
    const blocked = await post({ voice: "male" }, { "x-forwarded-for": "10.0.0.2, 198.51.100.1" });
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    // First session was at t=0, now t=5s, window 600s.
    expect(blocked.headers.get("retry-after")).toBe("595");
    // Another client is unaffected.
    expect((await post({ voice: "male" }, { "x-forwarded-for": "198.51.100.2" })).status).toBe(200);
    advance(595_000);
    expect((await post({ voice: "male" }, { "x-forwarded-for": "198.51.100.1" })).status).toBe(200);
  });

  test("daily cap returns 429 until the next UTC day", async () => {
    const { post, advance } = setup({
      voiceDemo: { daily: 2 },
      start: Date.parse("2026-11-09T12:00:00Z"),
    });
    expect((await post({ voice: "male" }, { "x-forwarded-for": "192.0.2.1" })).status).toBe(200);
    expect((await post({ voice: "male" }, { "x-forwarded-for": "192.0.2.2" })).status).toBe(200);
    const blocked = await post({ voice: "male" }, { "x-forwarded-for": "192.0.2.3" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe(String(12 * 3600));
    advance(12 * 3600 * 1000);
    expect((await post({ voice: "male" }, { "x-forwarded-for": "192.0.2.3" })).status).toBe(200);
  });

  test("CORS preflight from https://pecorva.com is allowed", async () => {
    const { app } = setup();
    const res = await app.request("/v1/voice/demo/session", {
      method: "OPTIONS",
      headers: {
        origin: "https://pecorva.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://pecorva.com");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("content-type");
  });
});

describe("voice demo allowance (180 s per 25 h per visitor)", () => {
  const H = 3_600_000;

  test("hanging up keeps the remaining time: a verified 30 s call leaves 150 s for the next one", async () => {
    const { post, conversations, advance } = setup();
    const first = await post({ voice: "male" });
    expect(((await first.json()) as { max_seconds: number }).max_seconds).toBe(180);
    conversations.set("conv_1", { status: "done", call_duration_secs: 29.4 });
    advance(40_000);
    const second = await post({ voice: "female" });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { max_seconds: number }).max_seconds).toBe(150);
  });

  test("used up: 429 allowance_used until the first call leaves the 25 h window", async () => {
    const { post, conversations, advance } = setup();
    await post({ voice: "male" });
    conversations.set("conv_1", { status: "done", call_duration_secs: 180 });
    advance(2 * H);
    const blocked = await post({ voice: "male" }, { origin: "https://pecorva.com" });
    expect(blocked.status).toBe(429);
    // The website reads Retry-After cross-origin to say when to come back.
    expect(blocked.headers.get("access-control-expose-headers")).toContain("Retry-After");
    const body = (await blocked.json()) as { error: { code: string }; remaining_seconds: number };
    expect(body.error.code).toBe("allowance_used");
    expect(body.remaining_seconds).toBe(0);
    expect(blocked.headers.get("retry-after")).toBe(String(23 * 3600));
    advance(23 * H - 1000);
    expect((await post({ voice: "male" })).status).toBe(429);
    advance(1000);
    expect((await post({ voice: "male" })).status).toBe(200);
  });

  test("a client that talks past max_seconds is charged the real length", async () => {
    const { post, conversations, advance } = setup();
    await post({ voice: "male" });
    conversations.set("conv_1", { status: "done", call_duration_secs: 50 });
    advance(60_000);
    expect(
      ((await (await post({ voice: "male" })).json()) as { max_seconds: number }).max_seconds,
    ).toBe(130);
    conversations.set("conv_2", { status: "done", call_duration_secs: 150 });
    advance(100_000);
    expect((await post({ voice: "male" })).status).toBe(429);
  });

  test("spoofed leading X-Forwarded-For hops, the same IPv6 /64 and a new app instance do not reset it", async () => {
    const conversations = new Map<string, Conversation>([
      ["conv_1", { status: "done", call_duration_secs: 175 }],
    ]);
    const a = setup({ conversations });
    expect(
      (await a.post({ voice: "male" }, { "x-forwarded-for": "2001:db8:aa:bb::1" })).status,
    ).toBe(200);
    a.advance(1000);
    for (const xff of [
      "6.6.6.6, 2001:db8:aa:bb::1",
      "2001:db8:aa:bb:ffff:1:2:3",
      "1.1.1.1,2001:0db8:00aa:00bb:0:0:0:9",
    ]) {
      const res = await a.post({ voice: "male" }, { "x-forwarded-for": xff });
      expect(res.status).toBe(429);
    }
    // Restart / second Cloud Run instance: same database, fresh process state.
    const b = setup({ conversations, start: Date.parse("2026-11-09T12:00:05Z") });
    expect(
      (await b.post({ voice: "male" }, { "x-forwarded-for": "2001:db8:aa:bb::77" })).status,
    ).toBe(429);
    // A different /64 is a different visitor.
    expect(
      (await b.post({ voice: "male" }, { "x-forwarded-for": "2001:db8:aa:bc::1" })).status,
    ).toBe(200);
  });

  test("parallel requests from one visitor never grant more than the allowance", async () => {
    const { post } = setup();
    const results = await Promise.all(Array.from({ length: 6 }, () => post({ voice: "male" })));
    const granted = results.filter((r) => r.status === 200);
    expect(granted).toHaveLength(1);
    expect(results.filter((r) => r.status === 429)).toHaveLength(5);
  });

  test("an open call blocks the next one with call_active", async () => {
    const { post, conversations, advance } = setup();
    await post({ voice: "male" });
    conversations.set("conv_1", { status: "in-progress" });
    advance(20_000);
    const res = await post({ voice: "male" });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("call_active");
    expect(res.headers.get("retry-after")).toBe("5");
  });

  test("a credential that never became a call is refunded after 15 min, not before", async () => {
    const { post, advance } = setup();
    await post({ voice: "male" });
    advance(14 * 60_000);
    expect((await post({ voice: "male" })).status).toBe(429);
    advance(60_000);
    const res = await post({ voice: "male" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { max_seconds: number }).max_seconds).toBe(180);
  });

  test("a failing conversation lookup fails closed and keeps the reservation", async () => {
    const { post, conversations, advance } = setup();
    await post({ voice: "male" });
    conversations.set("conv_1", 500);
    advance(30 * 60_000);
    const res = await post({ voice: "male" });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("allowance_used");
  });

  test("an upstream mint failure does not consume the allowance", async () => {
    let ok = false;
    const { post } = setup({
      upstream: () =>
        ok
          ? Response.json({ token: "tok", conversation_id: "conv_x" })
          : new Response("{}", { status: 500 }),
    });
    expect((await post({ voice: "male" })).status).toBe(502);
    ok = true;
    const res = await post({ voice: "male" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { max_seconds: number }).max_seconds).toBe(180);
  });

  test("client address is the last X-Forwarded-For hop; IPv6 groups by /64", () => {
    expect(clientIp("6.6.6.6, 7.7.7.7,203.0.113.9")).toBe("203.0.113.9");
    expect(clientIp(undefined)).toBe("unknown");
    expect(visitorKey("203.0.113.9")).toBe("203.0.113.9");
    expect(visitorKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(visitorKey("2001:bb6:c8fd:3b00:b159:9517:c665:e06f")).toBe("2001:bb6:c8fd:3b00::/64");
    expect(visitorKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
  });
});
