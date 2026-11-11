import { expect, test } from "bun:test";
import { farmSubscriptions, hardwareOrders, stripeEvents } from "../src/db";
import { createLogMailer } from "../src/mailer";
import { subscription, webhook } from "./billing-events";
import { billingFixture, FARM, SECRET } from "./billing-fixture";

const { app, db, session } = billingFixture();

for (const plan of ["orion", "cam2", "cam4", "cam6"] as const) {
  test.each(["metadata", "lookup-month", "lookup-year"])(
    `subscription webhook accepts ${plan} from %s`,
    async (source) => {
      const interval = source === "lookup-year" ? "year" : "month";
      const value = {
        ...subscription,
        metadata: source === "metadata" ? { farm_id: FARM, plan, interval } : { farm_id: FARM },
        items: {
          data: [
            {
              price: {
                lookup_key: `pecorva_${plan}_${interval === "month" ? "monthly" : "yearly"}`,
                recurring: { interval },
              },
            },
          ],
        },
      };
      const response = await webhook(app(), { value });
      expect(response.status).toBe(200);
      expect(
        await db
          .select({ plan: farmSubscriptions.plan, interval: farmSubscriptions.interval })
          .from(farmSubscriptions),
      ).toEqual([{ plan, interval }]);
    },
  );
}

test.each(["pen", "barn", "free", "cam3", "unknown"])(
  "subscription webhook rejects invalid metadata plan %s",
  async (plan) => {
    const response = await webhook(app(), {
      value: {
        ...subscription,
        metadata: { farm_id: FARM, plan, interval: "month" },
        items: {
          data: [
            { price: { lookup_key: "pecorva_cam2_monthly", recurring: { interval: "month" } } },
          ],
        },
      },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_subscription" } });
    expect(await db.select().from(stripeEvents)).toEqual([]);
  },
);

test.each([
  "pecorva_pen_monthly",
  "pecorva_barn_yearly",
  "pecorva_cam3_monthly",
  "other_cam2_monthly",
])("subscription webhook rejects invalid lookup key %s", async (key) => {
  const response = await webhook(app(), {
    value: {
      ...subscription,
      metadata: { farm_id: FARM },
      items: { data: [{ price: { lookup_key: key, recurring: { interval: "month" } } }] },
    },
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "invalid_subscription" } });
});

test("a paid subscription checkout records hardware and mails once alongside the plan", async () => {
  const mailer = createLogMailer(() => {});
  const a = app({
    mailer,
    fetch: async () => Response.json(subscription),
    billing: { secretKey: "sk_test", webhookSecret: SECRET, ordersEmail: "orders@pecorva.test" },
  });
  const value = {
    id: "cs_combined",
    mode: "subscription",
    payment_status: "paid",
    customer: "cus_test",
    subscription: "sub_test",
    amount_total: 126900,
    currency: "eur",
    customer_details: { email: "owner@example.test" },
    shipping_details: { name: "Owner", address: { country: "FR" } },
    metadata: {
      farm_id: FARM,
      plan: "cam2",
      interval: "month",
      box: "1",
      cameras: "2",
      user_id: session.userId,
    },
  };
  expect((await webhook(a, { type: "checkout.session.completed", value })).status).toBe(200);
  await webhook(a, { type: "checkout.session.completed", value });
  expect(await db.select().from(hardwareOrders)).toMatchObject([
    {
      stripeCheckoutSessionId: "cs_combined",
      boxes: 1,
      cameras: 2,
      status: "paid",
      userId: session.userId,
      amountTotal: 126900,
      currency: "eur",
      shipping: { name: "Owner", address: { country: "FR" } },
    },
  ]);
  expect(await db.select({ plan: farmSubscriptions.plan }).from(farmSubscriptions)).toEqual([
    { plan: "cam2" },
  ]);
  expect(mailer.sent.map((mail) => mail.template)).toEqual([
    "plan_active",
    "hardware_order",
    "order_notice",
  ]);
});

test("delayed subscription hardware payment mails once even with distinct success events", async () => {
  const mailer = createLogMailer(() => {});
  const a = app({
    mailer,
    fetch: async () => Response.json(subscription),
    billing: { secretKey: "sk_test", webhookSecret: SECRET, ordersEmail: "orders@pecorva.test" },
  });
  const value = {
    id: "cs_delayed",
    mode: "subscription",
    payment_status: "unpaid",
    customer: "cus_test",
    subscription: "sub_test",
    customer_details: { email: "owner@example.test" },
    metadata: {
      farm_id: FARM,
      plan: "cam2",
      interval: "month",
      box: "1",
      cameras: "0",
      user_id: session.userId,
    },
  };
  await webhook(a, { id: "evt_pending", type: "checkout.session.completed", value });
  expect(mailer.sent.map((mail) => mail.template)).toEqual(["plan_active"]);
  for (const id of ["evt_paid1", "evt_paid2"]) {
    expect(
      (await webhook(a, { id, type: "checkout.session.async_payment_succeeded", value })).status,
    ).toBe(200);
  }
  expect(mailer.sent.map((mail) => mail.template)).toEqual([
    "plan_active",
    "hardware_order",
    "order_notice",
  ]);
  expect(await db.select({ status: hardwareOrders.status }).from(hardwareOrders)).toEqual([
    { status: "paid" },
  ]);
});
