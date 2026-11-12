import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { farmMembers, users, voiceUsage } from "../src/db";
import { FARM, NOW } from "./billing-fixture";
import { multiUserFixture } from "./multi-user-fixture";
import { deferred, serveAgent, socketEvent } from "./voice-agent-fixture";

const { db, person, memberHeaders, join } = multiUserFixture();

test.each([false, true])(
  "voice without farm permission meters personal seconds with farm header %s",
  async (farm) => {
    if (farm) await join();
    let clock = NOW.getTime();
    const upstreamClosed = deferred<void>();
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        message() {},
        close() {
          upstreamClosed.resolve();
        },
      },
    });
    const gateway = serveAgent(db, {
      now: () => new Date(clock),
      fetch: async () => Response.json({ signed_url: `ws://127.0.0.1:${upstream.port}` }),
    });
    const client = new WebSocket(gateway.url.replace("http:", "ws:"), {
      headers: memberHeaders(farm),
    });
    try {
      await socketEvent(client, "open");
      clock += 2500;
      client.close();
      await gateway.closed;
      await upstreamClosed.promise;
      expect(await db.select().from(voiceUsage)).toMatchObject([
        {
          farmId: farm ? FARM : null,
          userId: person.id,
          accountId: person.id,
          seconds: 3,
        },
      ]);
    } finally {
      client.close();
      await gateway.server.stop(true);
      await upstream.stop(true);
    }
  },
);

test("voice uses the personal account's exhausted allowance without a farm", async () => {
  await db.insert(voiceUsage).values({
    accountId: person.id,
    userId: person.id,
    seconds: 1800,
    model: "live",
    createdAt: NOW.toISOString(),
  });
  const gateway = serveAgent(db, { now: () => NOW });
  try {
    const response = await fetch(gateway.url, { headers: memberHeaders(false) });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: "budget_exceeded" } });
  } finally {
    await gateway.server.stop(true);
  }
});

test("a personal free month requires a confirmed email before voice access", async () => {
  await db.update(users).set({ emailVerifiedAt: null }).where(eq(users.id, person.id));
  const gateway = serveAgent(db, { now: () => NOW });
  try {
    const response = await fetch(gateway.url, { headers: memberHeaders(false) });
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ error: { code: "plan_required" } });
  } finally {
    await gateway.server.stop(true);
  }
});

test("a zero member cap blocks farm billed voice", async () => {
  await join(true);
  await db
    .update(farmMembers)
    .set({ monthlyTokenLimit: 0 })
    .where(eq(farmMembers.userId, person.id));
  const gateway = serveAgent(db, { now: () => NOW });
  try {
    const response = await fetch(gateway.url, { headers: memberHeaders() });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: "member_limit" } });
  } finally {
    await gateway.server.stop(true);
  }
});
