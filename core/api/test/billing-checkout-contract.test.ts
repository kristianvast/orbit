import { expect, test } from "bun:test";
import { billingCustomers } from "../src/db";
import type { FetchLike } from "../src/shape";
import { billingFixture, FARM } from "./billing-fixture";
import { stripeFake } from "./billing-stripe";

const { app, db, headers, session } = billingFixture();

/** Stripe's portal endpoint, recording the form it was sent. */
function portalFake(forms: URLSearchParams[]): FetchLike {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname !== "/v1/billing_portal/sessions")
      throw new TypeError(`Unexpected Stripe request ${url}`);
    forms.push(new URLSearchParams(String(init?.body)));
    return Response.json({ url: "https://billing.stripe.test/portal" });
  };
}

test.each([
  ["orion", "month", "pecorva_orion_monthly"],
  ["orion", "year", "pecorva_orion_yearly"],
  ["cam2", "month", "pecorva_cam2_monthly"],
  ["cam2", "year", "pecorva_cam2_yearly"],
  ["cam4", "month", "pecorva_cam4_monthly"],
  ["cam4", "year", "pecorva_cam4_yearly"],
  ["cam6", "month", "pecorva_cam6_monthly"],
  ["cam6", "year", "pecorva_cam6_yearly"],
])("checkout uses the Stripe lookup for %s/%s", async (plan, interval, key) => {
  const forms: URLSearchParams[] = [];
  const response = await app({ fetch: stripeFake(forms) }).request("/v1/billing/checkout", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ plan, interval }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ url: "https://checkout.stripe.test/combined" });
  expect(Object.fromEntries(forms[0] ?? [])).toMatchObject({
    mode: "subscription",
    "line_items[0][price]": `price_${key}`,
    "metadata[plan]": plan,
    "subscription_data[metadata][interval]": interval,
  });
  expect(forms[0]?.has("shipping_address_collection[allowed_countries][0]")).toBe(false);
});

test.each(["pen", "barn", "free", "cam3", "unknown", null, 3])(
  "checkout rejects invalid plan %s",
  async (plan) => {
    const response = await app().request("/v1/billing/checkout", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ plan, interval: "month" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
  },
);

test.each(["monthly", "", null, 1])("checkout rejects invalid interval %s", async (interval) => {
  const response = await app().request("/v1/billing/checkout", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ plan: "orion", interval }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
});

for (const path of ["/v1/billing/checkout", "/v1/billing/hardware-checkout"]) {
  test.each([
    { box: -1 },
    { box: 0.5 },
    { box: 21 },
    { box: "1" },
    { box: null },
    { cameras: -1 },
    { cameras: 1.5 },
    { cameras: 65 },
    { cameras: "2" },
    { cameras: null },
  ])(`${path} rejects invalid hardware quantities %j`, async (quantity) => {
    const response = await app().request(path, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ plan: "orion", interval: "month", box: 1, ...quantity }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
  });
}

test("combined checkout adds hardware, shipping and buyer metadata to the subscription", async () => {
  const forms: URLSearchParams[] = [];
  const response = await app({ fetch: stripeFake(forms) }).request("/v1/billing/checkout", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ plan: "cam4", interval: "year", box: 1, cameras: 4 }),
  });
  expect(response.status).toBe(200);
  expect(Object.fromEntries(forms[0] ?? [])).toMatchObject({
    mode: "subscription",
    "line_items[0][price]": "price_pecorva_cam4_yearly",
    "line_items[1][price]": "price_pecorva_box",
    "line_items[1][quantity]": "1",
    "line_items[2][price]": "price_pecorva_camera",
    "line_items[2][quantity]": "4",
    "metadata[box]": "1",
    "metadata[cameras]": "4",
    "metadata[user_id]": session.userId,
    "subscription_data[metadata][farm_id]": FARM,
    "shipping_address_collection[allowed_countries][0]": "AT",
    "shipping_address_collection[allowed_countries][34]": "NZ",
  });
});

test.each([undefined, "Bearer invalid", "Bearer orb_s_invalid"])(
  "hardware checkout requires a session (%s)",
  async (authorization) => {
    const response = await app().request("/v1/billing/hardware-checkout", {
      method: "POST",
      headers: authorization ? { authorization } : {},
      body: JSON.stringify({ box: 1, email: "guest@example.test" }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
  },
);

test("hardware checkout uses the account email and supplied redirects without a farm header", async () => {
  const forms: URLSearchParams[] = [];
  const response = await app({ fetch: stripeFake(forms) }).request(
    "/v1/billing/hardware-checkout",
    {
      method: "POST",
      headers: { authorization: headers().authorization },
      body: JSON.stringify({
        box: 20,
        cameras: 64,
        email: "other@example.test",
        successUrl: "http://localhost:3000/account/?checkout=success&order=hardware",
        cancelUrl: "http://localhost:3000/pricing/?checkout=cancel",
      }),
    },
  );
  expect(response.status).toBe(200);
  expect(Object.fromEntries(forms[0] ?? [])).toMatchObject({
    mode: "payment",
    customer_email: "owner@example.test",
    success_url: "http://localhost:3000/account/?checkout=success&order=hardware",
    cancel_url: "http://localhost:3000/pricing/?checkout=cancel",
    "line_items[0][quantity]": "20",
    "line_items[1][quantity]": "64",
    "metadata[user_id]": session.userId,
  });
});

for (const path of ["/v1/billing/checkout", "/v1/billing/hardware-checkout"]) {
  test.each(["successUrl", "cancelUrl"])(`${path} rejects unsafe %s`, async (field) => {
    const response = await app({ fetch: stripeFake([]) }).request(path, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        plan: "orion",
        interval: "month",
        box: 1,
        [field]: "http://evil.test",
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
  });

  test.each(["successUrl", "cancelUrl"])(
    `${path} refuses to send the buyer to a foreign https site via %s`,
    async (field) => {
      const forms: URLSearchParams[] = [];
      const response = await app({ fetch: stripeFake(forms) }).request(path, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          plan: "orion",
          interval: "month",
          box: 1,
          [field]: "https://evil.example/after-payment",
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
      expect(forms).toHaveLength(0);
    },
  );
}

test("checkout passes a website redirect with its own path and query through to Stripe", async () => {
  const forms: URLSearchParams[] = [];
  const response = await app({ fetch: stripeFake(forms) }).request("/v1/billing/checkout", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      plan: "cam2",
      interval: "month",
      successUrl: "http://localhost:3000/account/?checkout=success&order=plan",
      cancelUrl: "http://localhost:3000/pricing/?checkout=cancel",
    }),
  });
  expect(response.status).toBe(200);
  expect(forms[0]?.get("success_url")).toBe(
    "http://localhost:3000/account/?checkout=success&order=plan",
  );
  expect(forms[0]?.get("cancel_url")).toBe("http://localhost:3000/pricing/?checkout=cancel");
});

test("a configured website origin may receive the buyer even when the defaults point elsewhere", async () => {
  const forms: URLSearchParams[] = [];
  const response = await app({
    fetch: stripeFake(forms),
    corsOrigins: ["https://pecorva.test"],
  }).request("/v1/billing/checkout", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      plan: "orion",
      interval: "year",
      successUrl: "https://pecorva.test/account/?checkout=success",
    }),
  });
  expect(response.status).toBe(200);
  expect(forms[0]?.get("success_url")).toBe("https://pecorva.test/account/?checkout=success");
  expect(forms[0]?.get("cancel_url")).toBe("http://localhost:3000/account/");
});

test("the billing portal returns to the website and refuses a foreign return address", async () => {
  await db.insert(billingCustomers).values({ farmId: FARM, stripeCustomerId: "cus_test" });
  const forms: URLSearchParams[] = [];
  const portal = (returnUrl?: string) =>
    app({ fetch: portalFake(forms) }).request("/v1/billing/portal", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(returnUrl ? { returnUrl } : {}),
    });

  const foreign = await portal("https://evil.example/steal");
  expect(foreign.status).toBe(400);
  expect(await foreign.json()).toMatchObject({ error: { code: "bad_request" } });
  expect(forms).toHaveLength(0);

  expect((await portal("http://localhost:3000/pricing/")).status).toBe(200);
  expect(forms[0]?.get("return_url")).toBe("http://localhost:3000/pricing/");

  expect((await portal()).status).toBe(200);
  expect(forms[1]?.get("return_url")).toBe("http://localhost:3000/account/");
});
