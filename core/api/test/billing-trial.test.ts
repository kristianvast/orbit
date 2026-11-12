import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  farmBudgets,
  farmMembers,
  farmSubscriptions,
  llmUsage,
  users,
  voiceUsage,
} from "../src/db";
import { EMAIL_REQUIRED } from "../src/entitlements";
import { billingFixture, FARM, NOW } from "./billing-fixture";

const { app, db, headers, session } = billingFixture();
const START = "2026-10-20T12:00:00.000Z";
const END = "2026-11-19T12:00:00.000Z";

async function trialOwner() {
  await db.update(users).set({ createdAt: START }).where(eq(users.id, session.userId));
}

test("the free month grants Orion allowances and reports its end while plan stays free", async () => {
  await trialOwner();
  const response = await app().request("/v1/billing/status", { headers: headers() });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    plan: "free",
    trialEndsAt: END,
    usage: { tokenAllowance: 2_000_000, voiceSecondsAllowance: 1800 },
  });
});

test("an unconfirmed owner gets no free month until the address is confirmed", async () => {
  await db
    .update(users)
    .set({ createdAt: START, emailVerifiedAt: null })
    .where(eq(users.id, session.userId));
  const pending = await app().request("/v1/billing/status", { headers: headers() });
  expect(await pending.json()).toMatchObject({
    plan: "free",
    trialEndsAt: null,
    usage: { tokenAllowance: 0, voiceSecondsAllowance: 0 },
  });
  const refused = await app({
    fetch: async () => {
      throw new TypeError("Must not call the model");
    },
  }).request("/v1/llm/v1/chat/completions", {
    method: "POST",
    headers: headers(),
    body: "{}",
  });
  expect(refused.status).toBe(402);
  expect(await refused.json()).toEqual(EMAIL_REQUIRED);

  await db
    .update(users)
    .set({ emailVerifiedAt: NOW.toISOString() })
    .where(eq(users.id, session.userId));
  const confirmed = await app().request("/v1/billing/status", { headers: headers() });
  expect(await confirmed.json()).toMatchObject({
    plan: "free",
    trialEndsAt: END,
    usage: { tokenAllowance: 2_000_000, voiceSecondsAllowance: 1800 },
  });
});

test("the free month permits the LLM gateway and records usage", async () => {
  await trialOwner();
  const response = await app({
    fetch: async () => Response.json({ usage: { total_tokens: 11, prompt_tokens: 6 } }),
  }).request("/v1/llm/v1/chat/completions", {
    method: "POST",
    headers: headers(),
    body: '{"model":"orbit-default"}',
  });
  expect(response.status).toBe(200);
  expect(await db.select({ tokens: llmUsage.totalTokens }).from(llmUsage)).toEqual([
    { tokens: 11 },
  ]);
});

test.each(["2026-11-19T12:00:00Z", "2026-11-20T12:00:00Z"])(
  "the free month is over at %s and blocks the model",
  async (at) => {
    await trialOwner();
    const response = await app({
      now: () => new Date(at),
      fetch: async () => {
        throw new TypeError("Must not call the model");
      },
    }).request("/v1/llm/v1/chat/completions", {
      method: "POST",
      headers: headers(),
      body: "{}",
    });
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ error: { code: "plan_required" } });
  },
);

test("status clears trialEndsAt after the free month", async () => {
  await trialOwner();
  const response = await app({ now: () => new Date("2026-11-20T12:00:00Z") }).request(
    "/v1/billing/status",
    { headers: headers() },
  );
  expect(await response.json()).toMatchObject({
    plan: "free",
    trialEndsAt: null,
    usage: { tokenAllowance: 0, voiceSecondsAllowance: 0 },
  });
});

test("free month status counts the single token and voice pool from the owner's creation date", async () => {
  await trialOwner();
  await db.insert(llmUsage).values([
    {
      farmId: FARM,
      accountId: FARM,
      path: "/x",
      status: 200,
      totalTokens: 99,
      createdAt: "2026-10-19T12:00:00Z",
    },
    { farmId: FARM, accountId: FARM, path: "/x", status: 200, totalTokens: 70, createdAt: START },
    {
      farmId: FARM,
      accountId: FARM,
      path: "/x",
      status: 200,
      totalTokens: 30,
      createdAt: NOW.toISOString(),
    },
  ]);
  await db.insert(voiceUsage).values([
    {
      farmId: FARM,
      accountId: FARM,
      model: "live",
      seconds: 99,
      createdAt: "2026-10-19T12:00:00Z",
    },
    { farmId: FARM, accountId: FARM, model: "live", seconds: 40, createdAt: START },
    { farmId: FARM, accountId: FARM, model: "live", seconds: 20, createdAt: NOW.toISOString() },
  ]);
  const response = await app().request("/v1/billing/status", { headers: headers() });
  expect(await response.json()).toMatchObject({
    usage: { tokensUsed: 100, voiceSecondsUsed: 60 },
  });
});

test("the gateway refuses an exhausted free pool from the previous calendar month", async () => {
  await trialOwner();
  await db.insert(llmUsage).values({
    farmId: FARM,
    accountId: FARM,
    path: "/x",
    status: 200,
    totalTokens: 2_000_000,
    createdAt: START,
  });
  const response = await app({
    fetch: async () => {
      throw new TypeError("Exhausted trial must not reach upstream");
    },
  }).request("/v1/llm/v1/chat/completions", {
    method: "POST",
    headers: headers(),
    body: "{}",
  });
  expect(response.status).toBe(429);
  expect(await response.json()).toMatchObject({
    error: { code: "budget_exceeded", used: 2_000_000, budget: 2_000_000 },
  });
});

test("the earliest owner account starts the month even if another owner joined later", async () => {
  await trialOwner();
  const [earlier] = await db
    .insert(users)
    .values({
      email: "earlier@example.test",
      createdAt: "2026-10-01T12:00:00Z",
    })
    .returning();
  if (!earlier) throw new TypeError("Owner fixture failed");
  await db.insert(farmMembers).values({ farmId: FARM, userId: earlier.id, role: "owner" });
  const response = await app().request("/v1/billing/status", { headers: headers() });
  expect(await response.json()).toMatchObject({
    plan: "free",
    trialEndsAt: null,
    usage: { tokenAllowance: 0, voiceSecondsAllowance: 0 },
  });
});

test("a farm without an owner has no free month", async () => {
  await trialOwner();
  await db
    .update(farmMembers)
    .set({ role: "manager" })
    .where(eq(farmMembers.userId, session.userId));
  const response = await app().request("/v1/billing/status", { headers: headers() });
  expect(await response.json()).toMatchObject({
    trialEndsAt: null,
    usage: { tokenAllowance: 0, voiceSecondsAllowance: 0 },
  });
});

test.each(["active", "trialing"])("a paid %s plan supersedes the free month", async (status) => {
  await trialOwner();
  await db
    .insert(farmSubscriptions)
    .values({ farmId: FARM, plan: "cam6", interval: "month", status });
  const response = await app().request("/v1/billing/status", { headers: headers() });
  expect(await response.json()).toMatchObject({
    plan: "cam6",
    trialEndsAt: null,
    usage: { tokenAllowance: 8_000_000, voiceSecondsAllowance: 9000 },
  });
});

test("a farm budget override still grants model access after the free month", async () => {
  await db.insert(farmBudgets).values({ farmId: FARM, monthlyTokenBudget: 123 });
  const response = await app({
    fetch: async () => Response.json({ usage: { total_tokens: 1 } }),
  }).request("/v1/llm/v1/chat/completions", { method: "POST", headers: headers(), body: "{}" });
  expect(response.status).toBe(200);
});

test.each(["free", "cam2"] as const)(
  "a zero budget override exhausts an available %s allowance",
  async (plan) => {
    await trialOwner();
    await db
      .insert(farmSubscriptions)
      .values({ farmId: FARM, plan, interval: "month", status: "active" });
    await db.insert(farmBudgets).values({ farmId: FARM, monthlyTokenBudget: 0 });
    const response = await app().request("/v1/llm/v1/chat/completions", {
      method: "POST",
      headers: headers(),
      body: "{}",
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: "budget_exceeded", budget: 0 } });
  },
);
