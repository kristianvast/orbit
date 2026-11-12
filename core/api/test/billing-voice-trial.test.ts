import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { users, voiceUsage } from "../src/db";
import { createVoiceGateway, type VoiceConnection } from "../src/voice";
import { billingFixture, FARM, NOW } from "./billing-fixture";

const { db, headers, session } = billingFixture();

test.each([
  { name: "the free month grants voice access", at: NOW, used: 0, status: 426 },
  {
    name: "previous calendar month voice consumes the free pool",
    at: NOW,
    used: 1800,
    status: 429,
  },
  {
    name: "day 31 ends free voice access",
    at: new Date("2026-11-20T12:00:00Z"),
    used: 0,
    status: 402,
  },
])("$name", async ({ at, used, status }) => {
  await db
    .update(users)
    .set({ createdAt: "2026-10-20T12:00:00Z" })
    .where(eq(users.id, session.userId));
  await db.insert(voiceUsage).values({
    farmId: FARM,
    accountId: FARM,
    model: "live",
    seconds: used,
    createdAt: "2026-10-21T12:00:00Z",
  });
  const gateway = createVoiceGateway(db, {
    now: () => at,
    accessToken: async () => {
      throw new TypeError("Must not reach Vertex");
    },
  });
  const server = Bun.serve<VoiceConnection>({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("unused"),
    websocket: gateway.websocket,
  });
  try {
    const response = await gateway.upgrade(
      new Request("http://localhost/v1/voice/live", {
        headers: headers(),
      }),
      server,
    );
    expect(response?.status).toBe(status);
    if (status === 402)
      expect(await response?.json()).toMatchObject({ error: { code: "plan_required" } });
    if (status === 429)
      expect(await response?.json()).toMatchObject({ error: { code: "budget_exceeded" } });
  } finally {
    await server.stop(true);
  }
});
