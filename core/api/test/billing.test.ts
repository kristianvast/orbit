import { expect, test } from "bun:test";
import { billingCustomers, farmSubscriptions, hardwareOrders, stripeEvents } from "../src/db";
import { createLogMailer } from "../src/mailer";
import { signed, subscription, webhook } from "./billing-events";
import { billingFixture, FARM, NOW, SECRET } from "./billing-fixture";

const { app, db, headers, session } = billingFixture();

test("a signed subscription update changes billing status and allowances", async () => {
  const a = app();
  expect((await webhook(a)).status).toBe(200);
  const response = await a.request("/v1/billing/status", { headers: headers() });
  expect(await response.json()).toMatchObject({
    plan: "cam2",
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
      metadata: { farm_id: FARM, plan: "cam2", interval: "month" },
    },
  });
  expect(mail.sent).toHaveLength(1);
  expect(mail.sent[0]).toMatchObject({ to: "owner@example.test", template: "plan_active" });
  expect(mail.sent[0]?.text).toContain("https://get.orbit.test");
  expect(mail.sent[0]?.text).toContain("sign in with owner@example.test");
});
