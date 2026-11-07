import { canManageMembers } from "@orbit/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Principal, resolveSession } from "./auth";
import { billingWebhook } from "./billing-webhook";
import { billingCustomers, type CoreDb, users } from "./db";
import { entitlements, usageThisMonth } from "./entitlements";
import { currency, hardware, lookupKey, plans } from "./plans";
import { BillingError, object, priceFor, type StripeOptions, string, stripeClient } from "./stripe";

export type FarmEnv = { Variables: { principal: Principal } };

function redirectUrl(value: unknown, fallback: string | undefined): string {
  const text = string(value ?? fallback, "redirect URL");
  let url: URL;
  try {
    url = new URL(text);
  } catch (error) {
    if (error instanceof TypeError)
      throw new BillingError(400, "bad_request", "Invalid redirect URL");
    throw error;
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
  ) {
    throw new BillingError(400, "bad_request", "Redirect URL must use HTTPS");
  }
  return url.href;
}

/** Stripe Tax, VAT number collection and a billing address on every Checkout Session. */
function addTaxFields(form: URLSearchParams, options: StripeOptions) {
  if (!options.automaticTax) return;
  form.set("automatic_tax[enabled]", "true");
  form.set("tax_id_collection[enabled]", "true");
  form.set("billing_address_collection", "required");
}

export function registerBillingRoutes(app: Hono<FarmEnv>, db: CoreDb, options: StripeOptions) {
  const routes = new Hono<FarmEnv>();
  const stripe = stripeClient(options);
  routes.onError((error, c) => {
    if (error instanceof BillingError)
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    if (error instanceof SyntaxError)
      return c.json({ error: { code: "bad_request", message: "Invalid JSON" } }, 400);
    throw error;
  });
  routes.get("/plans", (c) =>
    c.json({
      currency,
      plans,
      hardware: hardware.map(({ id, name, price }) => ({ id, name, price })),
    }),
  );
  routes.post("/webhook", (c) => billingWebhook(db, c.req.raw, options));
  routes.post("/hardware-checkout", async (c) => {
    const body = object(await c.req.json());
    const boxes = body.box ?? 0;
    const cameras = body.cameras ?? 0;
    if (
      typeof boxes !== "number" ||
      typeof cameras !== "number" ||
      !Number.isSafeInteger(boxes) ||
      !Number.isSafeInteger(cameras) ||
      boxes < 0 ||
      cameras < 0 ||
      boxes + cameras === 0
    ) {
      throw new BillingError(400, "bad_request", "Choose a positive number of boxes or cameras");
    }
    const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "")?.[1]?.trim();
    const buyer = bearer ? await resolveSession(db, bearer, options.now()) : null;
    const form = new URLSearchParams({
      mode: "payment",
      currency,
      success_url: redirectUrl(undefined, options.successUrl),
      cancel_url: redirectUrl(undefined, options.cancelUrl),
      customer_creation: "always",
      "invoice_creation[enabled]": "true",
      "metadata[box]": String(boxes),
      "metadata[cameras]": String(cameras),
    });
    if (buyer) {
      form.set("metadata[user_id]", buyer.id);
      form.set("customer_email", buyer.email);
    }
    addTaxFields(form, options);
    for (const [index, country] of [
      "AT",
      "BE",
      "BG",
      "HR",
      "CY",
      "CZ",
      "DK",
      "EE",
      "FI",
      "FR",
      "DE",
      "GR",
      "HU",
      "IE",
      "IT",
      "LV",
      "LT",
      "LU",
      "MT",
      "NL",
      "PL",
      "PT",
      "RO",
      "SK",
      "SI",
      "ES",
      "SE",
      "NO",
      "IS",
      "CH",
      "GB",
      "US",
      "CA",
      "AU",
      "NZ",
    ].entries()) {
      form.set(`shipping_address_collection[allowed_countries][${index}]`, country);
    }
    if (body.email !== undefined && !buyer) {
      const email = string(body.email, "email");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new BillingError(400, "bad_request", "Invalid email");
      form.set("customer_email", email);
    }
    let index = 0;
    for (const [quantity, key] of [
      [boxes, "pecorva_box"],
      [cameras, "pecorva_camera"],
    ] as const) {
      if (quantity === 0) continue;
      form.set(`line_items[${index}][price]`, await priceFor(stripe, key));
      form.set(`line_items[${index}][quantity]`, String(quantity));
      index++;
    }
    const session = await stripe("checkout/sessions", form);
    return c.json({ url: string(session.url, "checkout URL") });
  });
  routes.use("*", async (c, next) => {
    if (["/checkout", "/portal", "/status"].some((suffix) => c.req.path.endsWith(suffix))) {
      const principal = c.get("principal");
      if (!principal.userId) throw new BillingError(401, "unauthorized", "Sign in first");
      if (!c.req.path.endsWith("/status") && !canManageMembers(principal.role))
        throw new BillingError(403, "forbidden", "Only owners and managers manage billing");
      if (c.req.path.endsWith("/checkout")) {
        const [user] = await db
          .select({ verifiedAt: users.emailVerifiedAt })
          .from(users)
          .where(eq(users.id, principal.userId));
        if (!user?.verifiedAt)
          throw new BillingError(403, "email_unverified", "Confirm your email address first");
      }
    }
    await next();
  });
  routes.get("/status", async (c) => {
    const farmId = c.get("principal").farmId;
    const { subscription, plan, tokenAllowance, voiceSecondsAllowance } = await entitlements(
      db,
      farmId,
    );
    return c.json({
      plan: plan.id,
      interval: subscription?.interval ?? null,
      status: subscription?.status ?? "free",
      currentPeriodEnd: subscription?.currentPeriodEnd
        ? new Date(subscription.currentPeriodEnd).toISOString()
        : null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      usage: {
        ...(await usageThisMonth(db, farmId, options.now())),
        tokenAllowance,
        voiceSecondsAllowance,
      },
    });
  });
  routes.post("/checkout", async (c) => {
    const body = object(await c.req.json());
    const { plan, interval } = body;
    if ((plan !== "pen" && plan !== "barn") || (interval !== "month" && interval !== "year"))
      throw new BillingError(400, "bad_request", "Choose pen or barn and month or year");
    const farmId = c.get("principal").farmId;
    let [customer] = await db
      .select()
      .from(billingCustomers)
      .where(eq(billingCustomers.farmId, farmId));
    if (!customer) {
      const [buyer] = await db
        .select({ email: users.email, name: users.name })
        .from(users)
        .where(eq(users.id, c.get("principal").userId as string));
      const created = await stripe(
        "customers",
        new URLSearchParams({
          "metadata[farm_id]": farmId,
          "metadata[user_id]": c.get("principal").userId as string,
          ...(buyer?.email ? { email: buyer.email } : {}),
          ...(buyer?.name ? { name: buyer.name } : {}),
        }),
        `farm-customer-${farmId}`,
      );
      const stripeCustomerId = string(created.id, "customer id");
      await db.insert(billingCustomers).values({ farmId, stripeCustomerId }).onConflictDoNothing();
      customer = { farmId, stripeCustomerId };
    }
    const form = new URLSearchParams({
      mode: "subscription",
      customer: customer.stripeCustomerId,
      "line_items[0][price]": await priceFor(stripe, lookupKey(plan, interval)),
      "line_items[0][quantity]": "1",
      success_url: redirectUrl(body.successUrl, options.successUrl),
      cancel_url: redirectUrl(body.cancelUrl, options.cancelUrl),
    });
    addTaxFields(form, options);
    if (options.automaticTax) {
      form.set("customer_update[address]", "auto");
      form.set("customer_update[name]", "auto");
    }
    const userId = c.get("principal").userId as string;
    for (const [key, value] of Object.entries({
      farm_id: farmId,
      plan,
      interval,
      user_id: userId,
    })) {
      form.set(`metadata[${key}]`, value);
      form.set(`subscription_data[metadata][${key}]`, value);
    }
    const session = await stripe("checkout/sessions", form);
    return c.json({ url: string(session.url, "checkout URL") });
  });
  routes.post("/portal", async (c) => {
    const body = object(await c.req.json());
    const [customer] = await db
      .select()
      .from(billingCustomers)
      .where(eq(billingCustomers.farmId, c.get("principal").farmId));
    if (!customer) throw new BillingError(404, "customer_missing", "Subscribe to a plan first");
    const session = await stripe(
      "billing_portal/sessions",
      new URLSearchParams({
        customer: customer.stripeCustomerId,
        return_url: redirectUrl(body.returnUrl, options.successUrl),
      }),
    );
    return c.json({ url: string(session.url, "portal URL") });
  });
  app.route("/v1/billing", routes);
}
