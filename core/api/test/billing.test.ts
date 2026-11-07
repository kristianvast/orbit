import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  billingCustomers,
  farmBudgets,
  farmMembers,
  farmSubscriptions,
  hardwareOrders,
  llmUsage,
  stripeEvents,
  users,
  voiceUsage,
} from "../src/db";
import { createLogMailer } from "../src/mailer";
import { app, db, FARM, headers, NOW, SECRET, session } from "./billing-fixture";

function signed(payload: string, timestamp = Math.floor(NOW.getTime() / 1000)) {
  const signature = createHmac("sha256", SECRET).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}
const subscription = {
  id: "sub_test",
  customer: "cus_test",
  metadata: { farm_id: FARM, plan: "pen", interval: "month" },
  status: "active",
  current_period_end: 1796644800,
  cancel_at_period_end: true,
};
async function webhook(
  a: ReturnType<typeof app>,
  options: {
    readonly id?: string;
    readonly signature?: string;
    readonly value?: object;
    readonly type?: string;
    readonly created?: number;
  } = {},
) {
  const payload = JSON.stringify({
    id: options.id ?? "evt_test",
    type: options.type ?? "customer.subscription.updated",
    ...(options.created === undefined ? {} : { created: options.created }),
    data: { object: options.value ?? subscription },
  });
  return a.request("/v1/billing/webhook", {
    method: "POST",
    headers: { "stripe-signature": options.signature ?? signed(payload) },
    body: payload,
  });
}
async function paid() {
  await db
    .insert(farmSubscriptions)
    .values({ farmId: FARM, plan: "pen", interval: "month", status: "active" });
}

test("a signed subscription update changes billing status and allowances", async () => {
  const a = app();
  expect((await webhook(a)).status).toBe(200);
  const response = await a.request("/v1/billing/status", { headers: headers() });
  expect(await response.json()).toMatchObject({
    plan: "pen",
    status: "active",
    interval: "month",
    cancelAtPeriodEnd: true,
    currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
    usage: {
      tokenAllowance: 3_000_000,
      voiceSecondsAllowance: 3600,
      tokensUsed: 0,
      voiceSecondsUsed: 0,
    },
  });
});
test.each(["t=1,v1=bad", `t=1793966400,v1=${"a".repeat(64)}`, ""])(
  "invalid signature %s does not apply an event",
  async (signature) => {
    expect((await webhook(app(), { signature })).status).toBe(400);
    expect(await db.select().from(stripeEvents)).toEqual([]);
    expect(await db.select().from(farmSubscriptions)).toEqual([]);
  },
);
test("a correctly signed event outside the five minute window is rejected", async () => {
  const payload = JSON.stringify({
    id: "evt_old",
    type: "customer.subscription.updated",
    data: { object: subscription },
  });
  const response = await app().request("/v1/billing/webhook", {
    method: "POST",
    headers: { "stripe-signature": signed(payload, Math.floor(NOW.getTime() / 1000) - 301) },
    body: payload,
  });
  expect(response.status).toBe(400);
});
test("replaying a signed event cannot overwrite a newer subscription", async () => {
  const a = app();
  await webhook(a);
  await webhook(a, { id: "evt_new", value: { ...subscription, status: "past_due" } });
  const replay = await webhook(a);
  expect(replay.status).toBe(200);
  expect((await db.select().from(farmSubscriptions))[0]?.status).toBe("past_due");
  expect((await db.select().from(stripeEvents)).map((event) => event.id).sort()).toEqual([
    "evt_new",
    "evt_test",
  ]);
});
test("a free session farm gets plan_required before calling a model", async () => {
  const response = await app({
    fetch: async () => {
      throw new TypeError("Must not reach upstream");
    },
  }).request("/v1/llm/v1/chat/completions", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ model: "orbit-default" }),
  });
  expect(response.status).toBe(402);
  expect(await response.json()).toMatchObject({ error: { code: "plan_required" } });
});
test("a paid farm at its allowance gets budget_exceeded", async () => {
  await paid();
  await db.insert(llmUsage).values({
    farmId: FARM,
    path: "/v1/chat/completions",
    status: 200,
    totalTokens: 3_000_000,
    createdAt: NOW.toISOString(),
  });
  const response = await app().request("/v1/llm/v1/chat/completions", {
    method: "POST",
    headers: headers(),
    body: "{}",
  });
  expect(response.status).toBe(429);
  expect(await response.json()).toMatchObject({
    error: { code: "budget_exceeded", budget: 3_000_000 },
  });
});
test("a farm budget override wins over its paid plan allowance", async () => {
  await paid();
  await db.insert(farmBudgets).values({ farmId: FARM, monthlyTokenBudget: 4 });
  await db.insert(llmUsage).values({
    farmId: FARM,
    path: "/x",
    status: 200,
    totalTokens: 4,
    createdAt: NOW.toISOString(),
  });
  const response = await app().request("/v1/llm/v1/chat/completions", {
    method: "POST",
    headers: headers(),
    body: "{}",
  });
  expect(response.status).toBe(429);
  expect(await response.json()).toMatchObject({ error: { budget: 4 } });
});
test("Vertex thinking tokens count toward the farm allowance", async () => {
  await paid();
  const response = await app({
    fetch: async () =>
      Response.json({
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 68 },
      }),
  }).request("/v1/llm/v1/chat/completions", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ model: "gemini" }),
  });
  expect(response.status).toBe(200);
  expect(await db.select().from(llmUsage)).toMatchObject([
    { inputTokens: 8, outputTokens: 60, totalTokens: 68 },
  ]);
});
test("workers cannot start a checkout", async () => {
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
    body: JSON.stringify({ plan: "pen", interval: "month" }),
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
        return Response.json({ data: [{ id: "price_pen" }] });
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
    body: JSON.stringify({ plan: "pen", interval: "month" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ url: "https://checkout.stripe.test/session" });
  expect(observed.lookup).toBe("pecorva_pen_monthly");
  expect(customerForm?.get("email")).toBe("owner@example.test");
  expect(Object.fromEntries(checkout ?? [])).toMatchObject({
    mode: "subscription",
    customer: "cus_test",
    "line_items[0][price]": "price_pen",
    "metadata[farm_id]": FARM,
    "subscription_data[metadata][farm_id]": FARM,
    "metadata[plan]": "pen",
    "subscription_data[metadata][interval]": "month",
  });
});
test("billing status includes metered voice usage", async () => {
  await paid();
  await db
    .insert(voiceUsage)
    .values({ farmId: FARM, seconds: 123, model: "gemini-3.8-live", createdAt: NOW.toISOString() });
  const response = await app().request("/v1/billing/status", { headers: headers() });
  expect(await response.json()).toMatchObject({
    usage: { voiceSecondsUsed: 123, voiceSecondsAllowance: 3600 },
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

test("an older subscription event delivered late never overwrites newer state", async () => {
  const a = app();
  const at = Math.floor(NOW.getTime() / 1000);
  await webhook(a, { id: "evt_new", created: at, value: { ...subscription, status: "canceled" } });
  const late = await webhook(a, { id: "evt_old", created: at - 60, value: subscription });
  expect(late.status).toBe(200);
  expect((await db.select().from(farmSubscriptions))[0]?.status).toBe("canceled");
  await webhook(a, {
    id: "evt_fail_old",
    created: at - 30,
    type: "invoice.payment_failed",
    value: { subscription: "sub_test" },
  });
  expect((await db.select().from(farmSubscriptions))[0]?.status).toBe("canceled");
  await webhook(a, { id: "evt_newest", created: at + 60, value: subscription });
  expect((await db.select().from(farmSubscriptions))[0]?.status).toBe("active");
});
test("the Stripe customer link decides the farm even when metadata names an old farm id", async () => {
  const moved = "00000000-0000-4000-8000-0000000000b9";
  await db.insert(billingCustomers).values({ farmId: moved, stripeCustomerId: "cus_test" });
  await webhook(app());
  expect((await db.select().from(farmSubscriptions)).map((s) => s.farmId)).toEqual([moved]);
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
    body: JSON.stringify({ plan: "pen", interval: "month" }),
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: "email_unverified" } });
});
function stripeFake(sessions: URLSearchParams[]) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/customers") return Response.json({ id: "cus_test" });
    if (url.pathname === "/v1/prices") return Response.json({ data: [{ id: "price_x" }] });
    if (url.pathname === "/v1/checkout/sessions") {
      sessions.push(new URLSearchParams(String(init?.body)));
      return Response.json({ url: "https://checkout.stripe.test/s" });
    }
    throw new TypeError(`Unexpected Stripe request ${url}`);
  };
}
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
    body: JSON.stringify({ plan: "barn", interval: "year" }),
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
    body: JSON.stringify({ plan: "pen", interval: "month" }),
  });
  expect(sessions[0]?.has("automatic_tax[enabled]")).toBe(false);
});
test("hardware orders keep shipping, wait for delayed payments and email once when paid", async () => {
  const mail = createLogMailer(() => {});
  const a = app({
    mailer: mail,
    billing: {
      secretKey: "sk_test",
      webhookSecret: SECRET,
      ordersEmail: "orders@pecorva.test",
    },
  });
  const order = {
    id: "cs_hw",
    mode: "payment",
    payment_status: "unpaid",
    amount_total: 122000,
    currency: "eur",
    customer_details: { email: "buyer@farm.test" },
    collected_information: { shipping_details: { name: "Kari", address: { country: "NO" } } },
    metadata: { box: "1", cameras: "2", user_id: session.userId },
  };
  await webhook(a, { id: "evt_hw1", type: "checkout.session.completed", value: order });
  expect(await db.select().from(hardwareOrders)).toMatchObject([
    {
      status: "pending",
      userId: session.userId,
      amountTotal: 122000,
      shipping: { name: "Kari", address: { country: "NO" } },
    },
  ]);
  expect(mail.sent).toEqual([]);
  await webhook(a, {
    id: "evt_hw2",
    type: "checkout.session.async_payment_succeeded",
    value: order,
  });
  await webhook(a, {
    id: "evt_hw2",
    type: "checkout.session.async_payment_succeeded",
    value: order,
  });
  expect((await db.select().from(hardwareOrders))[0]?.status).toBe("paid");
  expect(mail.sent.map((m) => [m.template, m.to])).toEqual([
    ["hardware_order", "buyer@farm.test"],
    ["order_notice", "orders@pecorva.test"],
  ]);
});
test("a completed plan checkout emails the buyer how to sign in to Orbit", async () => {
  const mail = createLogMailer(() => {});
  const a = app({
    mailer: mail,
    links: { siteUrl: "https://pecorva.test", downloadUrl: "https://get.orbit.test" },
    fetch: async () => Response.json(subscription),
  });
  await webhook(a, {
    id: "evt_paid",
    type: "checkout.session.completed",
    value: {
      mode: "subscription",
      customer: "cus_test",
      subscription: "sub_test",
      customer_details: { email: "owner@example.test" },
      metadata: { farm_id: FARM, plan: "pen", interval: "month" },
    },
  });
  expect(mail.sent).toHaveLength(1);
  expect(mail.sent[0]).toMatchObject({ to: "owner@example.test", template: "plan_active" });
  expect(mail.sent[0]?.text).toContain("https://get.orbit.test");
  expect(mail.sent[0]?.text).toContain("sign in with owner@example.test");
});
