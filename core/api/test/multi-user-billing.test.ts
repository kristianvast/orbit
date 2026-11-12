import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { billingCustomers, farmMembers, farmSubscriptions, users } from "../src/db";
import { webhook } from "./billing-events";
import { FARM, NOW } from "./billing-fixture";
import { stripeFake } from "./billing-stripe";
import { multiUserFixture } from "./multi-user-fixture";

const { app, db, headers, session, person, memberHeaders, join } = multiUserFixture();

test("personal billing status works without a farm header", async () => {
  const response = await app().request("/v1/billing/status", { headers: memberHeaders(false) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    account: "personal",
    farmPlanAllowed: false,
    usageSource: null,
    member: null,
    farm: null,
    personal: {
      plan: "free",
      tokensUsed: 0,
      tokenAllowance: 2_000_000,
      trialEndsAt: new Date(NOW.getTime() + 30 * 86400000).toISOString(),
    },
  });
});

test.each(["checkout", "portal"])(
  "a worker may manage personal %s while on a farm",
  async (endpoint) => {
    await join();
    await db
      .insert(billingCustomers)
      .values({ farmId: person.id, stripeCustomerId: "cus_personal" });
    const forms: URLSearchParams[] = [];
    const a = app({
      fetch: async (input, init) => {
        if (String(input).endsWith("/billing_portal/sessions")) {
          forms.push(new URLSearchParams(String(init?.body)));
          return Response.json({ url: "https://stripe.test/portal" });
        }
        return stripeFake(forms)(input, init);
      },
    });
    const response = await a.request(`/v1/billing/${endpoint}`, {
      method: "POST",
      headers: memberHeaders(),
      body: JSON.stringify({ plan: "orion", interval: "month" }),
    });
    expect(response.status).toBe(200);
    expect(forms[0]?.get("customer")).toBe("cus_personal");
  },
);

test("an owner can explicitly choose personal checkout despite having a farm header", async () => {
  const forms: URLSearchParams[] = [];
  const response = await app({ fetch: stripeFake(forms) }).request("/v1/billing/checkout", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ plan: "orion", interval: "month", account: "personal" }),
  });
  expect(response.status).toBe(200);
  expect(forms[0]?.get("metadata[farm_id]")).toBe(session.userId);
});

test("personal portal works without a farm header", async () => {
  await db.insert(billingCustomers).values({ farmId: person.id, stripeCustomerId: "cus_personal" });
  const response = await app({
    fetch: async () => Response.json({ url: "https://stripe.test/personal" }),
  }).request("/v1/billing/portal", { method: "POST", headers: memberHeaders(false), body: "{}" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ url: "https://stripe.test/personal" });
});

test("subscription webhooks resolve a personal customer to the user account", async () => {
  await db.insert(billingCustomers).values({ farmId: person.id, stripeCustomerId: "cus_personal" });
  const response = await webhook(app(), {
    value: {
      id: "sub_personal",
      customer: "cus_personal",
      status: "active",
      metadata: { farm_id: FARM, plan: "orion", interval: "month", account: "personal" },
      items: { data: [] },
    },
  });
  expect(response.status).toBe(200);
  expect(
    await db.select().from(farmSubscriptions).where(eq(farmSubscriptions.farmId, person.id)),
  ).toMatchObject([{ plan: "orion", stripeSubscriptionId: "sub_personal" }]);
});

test("deleting an account refuses a running personal subscription", async () => {
  await db
    .update(users)
    .set({ passwordHash: await Bun.password.hash("correct password") })
    .where(eq(users.id, person.id));
  await db.insert(farmSubscriptions).values({ farmId: person.id, plan: "orion", status: "active" });
  const response = await app().request("/v1/me", {
    method: "DELETE",
    headers: memberHeaders(false),
    body: JSON.stringify({ password: "correct password" }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "subscription_active" } });
});

test("me reports membership billing settings and the personal paid plan", async () => {
  await join(true);
  await db
    .update(farmMembers)
    .set({ monthlyTokenLimit: 120, usageSource: "own" })
    .where(eq(farmMembers.userId, person.id));
  await db.insert(farmSubscriptions).values({ farmId: person.id, plan: "cam2", status: "active" });
  const response = await app().request("/v1/me", { headers: memberHeaders(false) });
  expect(await response.json()).toMatchObject({
    personal: { plan: "cam2" },
    farms: [
      {
        farmId: FARM,
        useFarmPlan: true,
        monthlyTokenLimit: 120,
        usageSource: "own",
      },
    ],
  });
});
