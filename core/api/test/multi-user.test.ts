import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { farmMembers, farmSubscriptions, llmUsage, voiceUsage } from "../src/db";
import { object } from "../src/stripe";
import { FARM, NOW } from "./billing-fixture";
import { multiUserFixture } from "./multi-user-fixture";

const { db, headers, session, person, gateway, memberHeaders, join, llm, memberKey } =
  multiUserFixture();
test("accepted invite without farm permission bills the member's personal free month", async () => {
  const a = await join();
  expect((await llm(a)).status).toBe(200);
  expect(await db.select().from(llmUsage)).toMatchObject([
    { farmId: FARM, userId: person.id, accountId: person.id, totalTokens: 7 },
  ]);
});

test("granting farm permission changes the next request's billing account", async () => {
  const a = await join();
  const response = await a.request(`/v1/farms/${FARM}/members/${person.id}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ useFarmPlan: true }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    member: {
      userId: person.id,
      email: "member@example.test",
      useFarmPlan: true,
      monthlyTokenLimit: null,
      usageSource: null,
    },
  });
  expect((await llm(a)).status).toBe(200);
  expect(await db.select().from(llmUsage)).toMatchObject([{ accountId: FARM, userId: person.id }]);
});

test("member list splits farm and own tokens and hides other people's usage from workers", async () => {
  const a = await join(true);
  await db.insert(llmUsage).values([
    {
      farmId: FARM,
      userId: person.id,
      accountId: FARM,
      path: "/x",
      status: 200,
      totalTokens: 11,
      createdAt: NOW.toISOString(),
    },
    {
      farmId: FARM,
      userId: person.id,
      accountId: person.id,
      path: "/x",
      status: 200,
      totalTokens: 13,
      createdAt: NOW.toISOString(),
    },
    {
      farmId: FARM,
      userId: person.id,
      accountId: FARM,
      path: "/x",
      status: 200,
      totalTokens: 99,
      createdAt: "2026-10-31T23:59:59Z",
    },
    {
      farmId: null,
      userId: person.id,
      accountId: person.id,
      path: "/x",
      status: 200,
      totalTokens: 101,
      createdAt: NOW.toISOString(),
    },
  ]);
  await db.insert(voiceUsage).values({
    farmId: FARM,
    userId: person.id,
    accountId: person.id,
    seconds: 17,
    model: "live",
    createdAt: NOW.toISOString(),
  });
  for (const auth of [headers(), memberHeaders()]) {
    const response = await a.request(`/v1/farms/${FARM}/members`, { headers: auth });
    const rows = object(await response.json()).members;
    if (!Array.isArray(rows)) throw new TypeError("Expected members");
    const members = rows.map(object);
    expect(members.find((m) => m.userId === person.id)?.usage).toEqual({
      farmTokens: 11,
      ownTokens: 13,
      voiceSeconds: 17,
    });
    const owner = members.find((m) => m.userId === session.userId);
    expect(owner?.usage).toEqual(
      auth.authorization === headers().authorization
        ? { farmTokens: 0, ownTokens: 0, voiceSeconds: 0 }
        : undefined,
    );
  }
});

test("member cap rejects a request at the calendar month's farm token limit", async () => {
  const a = await join(true);
  await db.update(farmMembers).set({ monthlyTokenLimit: 7 }).where(memberKey());
  await db.insert(llmUsage).values([
    {
      farmId: FARM,
      userId: person.id,
      accountId: FARM,
      path: "/x",
      status: 200,
      totalTokens: 7,
      createdAt: "2026-10-31T23:59:59Z",
    },
    {
      farmId: FARM,
      userId: person.id,
      accountId: person.id,
      path: "/x",
      status: 200,
      totalTokens: 99,
      createdAt: NOW.toISOString(),
    },
  ]);
  expect((await llm(a)).status).toBe(200);
  const denied = await llm(a);
  expect(denied.status).toBe(429);
  expect(await denied.json()).toMatchObject({ error: { code: "member_limit" } });
  expect((await llm(a, false)).status).toBe(200);
});

test.each([{ useFarmPlan: false }, { monthlyTokenLimit: 0 }])(
  "owners cannot be restricted with %j",
  async (patch) => {
    const response = await gateway().request(`/v1/farms/${FARM}/members/${session.userId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify(patch),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "owner_usage" } });
  },
);

test("a session without a farm uses its own confirmed free month", async () => {
  expect((await llm(gateway(), false)).status).toBe(200);
  expect(await db.select().from(llmUsage)).toMatchObject([
    { farmId: null, accountId: person.id, userId: person.id },
  ]);
});

test("choosing own source routes farm requests to personal billing and reports both accounts", async () => {
  const a = await join(true);
  const response = await a.request(`/v1/farms/${FARM}/me`, {
    method: "PATCH",
    headers: memberHeaders(),
    body: JSON.stringify({ usageSource: "own" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ member: { usageSource: "own" } });
  expect((await llm(a)).status).toBe(200);
  const status = await a.request("/v1/billing/status", { headers: memberHeaders() });
  expect(await status.json()).toMatchObject({
    account: "personal",
    usageSource: "own",
    farmPlanAllowed: true,
    member: { tokensUsed: 0, tokenLimit: null },
    usage: { tokensUsed: 7 },
    personal: { plan: "free", tokensUsed: 7, tokenAllowance: 2_000_000 },
    farm: { plan: "orion", tokensUsed: 0, tokenAllowance: 2_000_000 },
  });
});

test("automatic source falls back to personal when the farm has no allowance", async () => {
  const a = await join(true);
  await db.delete(farmSubscriptions).where(eq(farmSubscriptions.farmId, FARM));
  expect((await llm(a)).status).toBe(200);
  expect(await db.select().from(llmUsage)).toMatchObject([{ accountId: person.id }]);
});

test("explicit farm source without permission still charges personal", async () => {
  const a = await join();
  await db.update(farmMembers).set({ usageSource: "farm" }).where(memberKey());
  expect((await llm(a)).status).toBe(200);
  expect(await db.select().from(llmUsage)).toMatchObject([{ accountId: person.id }]);
});

test("promotion to owner restores unlimited farm permission", async () => {
  const a = await join();
  await db.update(farmMembers).set({ monthlyTokenLimit: 1 }).where(memberKey());
  const response = await a.request(`/v1/farms/${FARM}/members/${person.id}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ role: "owner" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    member: {
      role: "owner",
      useFarmPlan: true,
      monthlyTokenLimit: null,
    },
  });
});
