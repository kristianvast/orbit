import { afterAll, beforeAll, beforeEach } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { type AppOptions, createApp } from "../src/app";
import { createSession } from "../src/auth";
import { type CoreDb, coreSchema, farmMembers, users } from "../src/db";
import { migrate } from "../src/migrate";

export const FARM = "00000000-0000-4000-8000-0000000000b1";
export const NOW = new Date("2026-11-06T12:00:00Z");
export const SECRET = "whsec_test";
export function billingFixture() {
  const client = new PGlite();
  const db: CoreDb = drizzle({ client, schema: coreSchema });
  // Session fixture state is replaced before each test.
  const session = { userId: "", token: "" };

  beforeAll(async () => {
    await migrate(db);
  }, 60_000);
  afterAll(async () => {
    await client.close();
  });
  beforeEach(async () => {
    await db.execute(
      sql`truncate billing_customers, farm_subscriptions, stripe_events, hardware_orders, voice_usage, farm_budgets, llm_usage, farm_members, user_sessions, users cascade`,
    );
    const [user] = await db
      .insert(users)
      .values({
        email: "owner@example.test",
        createdAt: new Date(NOW.getTime() - 31 * 86_400_000).toISOString(),
        passwordHash: "unused",
        emailVerifiedAt: NOW.toISOString(),
      })
      .returning();
    if (!user) throw new TypeError("User fixture failed");
    session.userId = user.id;
    session.token = (await createSession(db, user.id, null, NOW)).token;
    await db
      .insert(farmMembers)
      .values({ farmId: FARM, userId: user.id, role: "owner", usageSource: "farm" });
  });

  const headers = () => ({
    authorization: `Bearer ${session.token}`,
    "x-orbit-farm": FARM,
    "content-type": "application/json",
  });

  function app(extra: Partial<AppOptions> = {}) {
    return createApp({
      db,
      resolveToken: async () => null,
      fetch: async () => {
        throw new TypeError("Unexpected external request in billing test");
      },
      electricUrl: "http://electric",
      now: () => NOW,
      billing: {
        secretKey: "sk_test",
        webhookSecret: SECRET,
        successUrl: "http://localhost:3000/account/",
        cancelUrl: "http://localhost:3000/account/",
      },
      llm: { upstreamUrl: "https://provider", upstreamApiKey: "test" },
      ...extra,
    });
  }
  return { db, session, headers, app };
}
