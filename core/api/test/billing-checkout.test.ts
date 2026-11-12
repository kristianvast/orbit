import { expect, test } from "bun:test";
import { pg } from "@orbit/schema";
import { eq } from "drizzle-orm";
import { billingCustomers, farmMembers, users } from "../src/db";
import { billingFixture, FARM, SECRET } from "./billing-fixture";
import { stripeFake } from "./billing-stripe";

const { app, db, headers, session } = billingFixture();

test("workers cannot start a farm checkout", async () => {
  await db
    .update(farmMembers)
    .set({ role: "worker" })
    .where(eq(farmMembers.userId, session.userId));
  const response = await app({
    fetch: async () => {
      throw new TypeError("Must not reach Stripe");
    },
  }).request("/v1/billing/checkout", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ plan: "cam2", interval: "month", account: "farm" }),
  });
  expect(response.status).toBe(403);
});
test("checkout resolves a lookup price and attaches the farm to session and subscription", async () => {
  let checkout: URLSearchParams | undefined;
  let customerForm: URLSearchParams | undefined;
  const observed: { lookup: string | null } = { lookup: null };
  const a = app({
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/customers") {
        customerForm = new URLSearchParams(String(init?.body));
        return Response.json({ id: "cus_test" });
      }
      if (url.pathname === "/v1/prices") {
        observed.lookup = url.searchParams.get("lookup_keys[]");
        return Response.json({ data: [{ id: "price_cam2" }] });
      }
      if (url.pathname === "/v1/checkout/sessions") {
        checkout = new URLSearchParams(String(init?.body));
        return Response.json({ url: "https://checkout.stripe.test/session" });
      }
      throw new TypeError(`Unexpected Stripe request ${url}`);
    },
  });
  const response = await a.request("/v1/billing/checkout", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ plan: "cam2", interval: "month" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ url: "https://checkout.stripe.test/session" });
  expect(observed.lookup).toBe("pecorva_cam2_monthly");
  expect(customerForm?.get("email")).toBe("owner@example.test");
  expect(Object.fromEntries(checkout ?? [])).toMatchObject({
    mode: "subscription",
    customer: "cus_test",
    "line_items[0][price]": "price_cam2",
    "metadata[farm_id]": FARM,
    "subscription_data[metadata][farm_id]": FARM,
    "metadata[plan]": "cam2",
    "subscription_data[metadata][interval]": "month",
  });
});
test.each(["/v1/me/sessions", "/v1/me/export", "/v1/me/password"])(
  "website preflight reaches account route %s",
  async (path) => {
    const response = await app().request(path, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  },
);
test("website preflight and public plans use the allowed origin", async () => {
  const response = await app().request("/v1/billing/plans", {
    method: "OPTIONS",
    headers: { origin: "http://localhost:3000", "access-control-request-method": "GET" },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
});

test("unverified accounts cannot start a checkout", async () => {
  await db.update(users).set({ emailVerifiedAt: null });
  const response = await app({
    fetch: async () => {
      throw new TypeError("Must not reach Stripe");
    },
  }).request("/v1/billing/checkout", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ plan: "cam2", interval: "month" }),
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: "email_unverified" } });
});
test("with automatic tax on, checkouts collect VAT ids and billing addresses", async () => {
  const sessions: URLSearchParams[] = [];
  const a = app({
    fetch: stripeFake(sessions),
    billing: {
      secretKey: "sk_test",
      webhookSecret: SECRET,
      successUrl: "http://localhost:3000/account/",
      cancelUrl: "http://localhost:3000/account/",
      automaticTax: true,
    },
  });
  await a.request("/v1/billing/checkout", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ plan: "cam6", interval: "year" }),
  });
  await a.request("/v1/billing/hardware-checkout", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ box: 1, cameras: 2 }),
  });
  const [subscriptionForm, hardwareForm] = sessions.map((s) => Object.fromEntries(s));
  expect(subscriptionForm).toMatchObject({
    "automatic_tax[enabled]": "true",
    "tax_id_collection[enabled]": "true",
    billing_address_collection: "required",
    "customer_update[address]": "auto",
    "metadata[user_id]": session.userId,
  });
  expect(hardwareForm).toMatchObject({
    "automatic_tax[enabled]": "true",
    "invoice_creation[enabled]": "true",
    customer_email: "owner@example.test",
    "metadata[user_id]": session.userId,
  });
});
test("without automatic tax the checkout carries no tax fields", async () => {
  const sessions: URLSearchParams[] = [];
  await app({ fetch: stripeFake(sessions) }).request("/v1/billing/checkout", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ plan: "cam2", interval: "month" }),
  });
  expect(sessions[0]?.has("automatic_tax[enabled]")).toBe(false);
});

test("checkout without x-orbit-farm buys a personal plan without creating a farm", async () => {
  await db.delete(farmMembers).where(eq(farmMembers.userId, session.userId));
  const sessions: URLSearchParams[] = [];
  const a = app({ fetch: stripeFake(sessions) });
  const response = await a.request("/v1/billing/checkout", {
    method: "POST",
    headers: {
      authorization: headers().authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({ plan: "orion", interval: "month" }),
  });
  expect(response.status).toBe(200);
  const createdMemberships = await db
    .select()
    .from(farmMembers)
    .where(eq(farmMembers.userId, session.userId));
  expect(createdMemberships).toEqual([]);
  expect(await db.select().from(pg.farms)).toEqual([]);
  expect(await db.select().from(billingCustomers)).toMatchObject([{ farmId: session.userId }]);
  expect(sessions[0]?.get("metadata[farm_id]")).toBe(session.userId);
  expect(sessions[0]?.get("metadata[account]")).toBe("personal");
  expect(sessions[0]?.get("subscription_data[metadata][account]")).toBe("personal");
});
