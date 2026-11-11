import { eq, sql } from "drizzle-orm";
import { billingCustomers, type CoreDb, farmSubscriptions } from "./db";
import { isPaidPlan, lookupKey, plans } from "./plans";
import { BillingError, object, string } from "./stripe";

export type BillingTx = Parameters<Parameters<CoreDb["transaction"]>[0]>[0];

type SubscriptionContext = {
  readonly tx: BillingTx;
  readonly now: Date;
  readonly eventAt: string;
};

export async function subscriptionUpdate(
  context: SubscriptionContext,
  value: Record<string, unknown>,
) {
  const { tx, now, eventAt } = context;
  const metadata = object(value.metadata ?? {});
  // Customer links survive adoption by an Orbit install; old Stripe metadata may not.
  let farmId: string | null = null;
  if (typeof value.customer === "string") {
    const [customer] = await tx
      .select()
      .from(billingCustomers)
      .where(eq(billingCustomers.stripeCustomerId, value.customer));
    farmId = customer?.farmId ?? null;
  }
  if (!farmId && typeof metadata.farm_id === "string") farmId = metadata.farm_id;
  if (!farmId) throw new BillingError(400, "missing_farm", "Subscription has no farm");
  const items = object(value.items ?? {});
  const first = Array.isArray(items.data) ? object(items.data[0] ?? {}) : {};
  const price = object(first.price ?? {});
  const recurring = object(price.recurring ?? {});
  const matched = plans.find(
    (plan) =>
      isPaidPlan(plan.id) &&
      [lookupKey(plan.id, "month"), lookupKey(plan.id, "year")].includes(String(price.lookup_key)),
  );
  const plan = metadata.plan ?? matched?.id;
  const interval = metadata.interval ?? recurring.interval;
  if (!isPaidPlan(plan) || (interval !== "month" && interval !== "year")) {
    throw new BillingError(400, "invalid_subscription", "Unknown subscription plan or interval");
  }
  const end = value.current_period_end ?? first.current_period_end;
  const row: typeof farmSubscriptions.$inferInsert = {
    farmId,
    plan,
    interval,
    status: string(value.status, "subscription status"),
    stripeSubscriptionId: string(value.id, "subscription id"),
    currentPeriodEnd: typeof end === "number" ? new Date(end * 1000).toISOString() : null,
    cancelAtPeriodEnd: value.cancel_at_period_end === true,
    updatedAt: now.toISOString(),
    stripeEventAt: eventAt,
  };
  // Stripe can deliver events out of order.
  await tx
    .insert(farmSubscriptions)
    .values(row)
    .onConflictDoUpdate({
      target: farmSubscriptions.farmId,
      set: row,
      setWhere: sql`${farmSubscriptions.stripeEventAt} is null or ${farmSubscriptions.stripeEventAt} <= ${eventAt}`,
    });
}
