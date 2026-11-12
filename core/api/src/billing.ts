import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Principal } from "./auth";
import {
  addHardware,
  addTaxFields,
  hardwareCheckout,
  hardwareSelection,
  redirectUrl,
} from "./billing-checkout";
import { billingStatus, checkoutAccount } from "./billing-status";
import { billingWebhook } from "./billing-webhook";
import { billingCustomers, type CoreDb, users } from "./db";
import { currency, hardware, isPaidPlan, lookupKey, plans, trialDays } from "./plans";
import { BillingError, object, priceFor, type StripeOptions, string, stripeClient } from "./stripe";

export type FarmEnv = { Variables: { principal: Principal } };

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
      locked: false,
      trialDays,
      plans,
      hardware: hardware.map(({ id, name, price }) => ({ id, name, price })),
    }),
  );
  routes.post("/webhook", (c) => billingWebhook(db, c.req.raw, options));
  routes.post("/hardware-checkout", (c) => hardwareCheckout(db, c.req.raw, options));
  routes.use("*", async (c, next) => {
    if (["/checkout", "/portal", "/status"].some((suffix) => c.req.path.endsWith(suffix))) {
      const principal = c.get("principal");
      if (!principal.userId) throw new BillingError(401, "unauthorized", "Sign in first");
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
    return c.json(await billingStatus(db, c.get("principal"), options.now()));
  });
  routes.post("/checkout", async (c) => {
    const body = object(await c.req.json());
    const { plan, interval } = body;
    if (!isPaidPlan(plan) || (interval !== "month" && interval !== "year"))
      throw new BillingError(
        400,
        "bad_request",
        "Choose an Orion or camera plan and month or year",
      );
    const selection = hardwareSelection(body);
    const principal = c.get("principal");
    const account = checkoutAccount(principal, body.account);
    const farmId = account.id;
    const userId = principal.userId;
    if (!userId) throw new BillingError(401, "unauthorized", "Sign in first");
    let [customer] = await db
      .select()
      .from(billingCustomers)
      .where(eq(billingCustomers.farmId, farmId));
    if (!customer) {
      const [buyer] = await db
        .select({ email: users.email, name: users.name })
        .from(users)
        .where(eq(users.id, userId));
      const created = await stripe(
        "customers",
        new URLSearchParams({
          "metadata[farm_id]": farmId,
          "metadata[user_id]": userId,
          "metadata[account]": account.kind,
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
      success_url: redirectUrl(body.successUrl, options.successUrl, options),
      cancel_url: redirectUrl(body.cancelUrl, options.cancelUrl, options),
    });
    addTaxFields(form, options);
    await addHardware(form, selection, stripe);
    if (options.automaticTax) {
      form.set("customer_update[address]", "auto");
      form.set("customer_update[name]", "auto");
    }
    for (const [key, value] of Object.entries({
      farm_id: farmId,
      plan,
      interval,
      user_id: userId,
      account: account.kind,
    })) {
      form.set(`metadata[${key}]`, value);
      form.set(`subscription_data[metadata][${key}]`, value);
    }
    const session = await stripe("checkout/sessions", form);
    return c.json({ url: string(session.url, "checkout URL") });
  });
  routes.post("/portal", async (c) => {
    const body = object(await c.req.json());
    const account = checkoutAccount(c.get("principal"), body.account);
    const [customer] = await db
      .select()
      .from(billingCustomers)
      .where(eq(billingCustomers.farmId, account.id));
    if (!customer) throw new BillingError(404, "customer_missing", "Subscribe to a plan first");
    const session = await stripe(
      "billing_portal/sessions",
      new URLSearchParams({
        customer: customer.stripeCustomerId,
        return_url: redirectUrl(body.returnUrl, options.successUrl, options),
      }),
    );
    return c.json({ url: string(session.url, "portal URL") });
  });
  app.route("/v1/billing", routes);
}
