import { sql } from "drizzle-orm";
import { completedHardware, hardwarePayment } from "./billing-orders";
import { type BillingTx, subscriptionUpdate } from "./billing-subscription";
import { billingCustomers, type CoreDb, farmSubscriptions, stripeEvents } from "./db";
import { type EmailMessage, emails } from "./mailer";
import {
  BillingError,
  object,
  type StripeClient,
  type StripeOptions,
  string,
  stripeClient,
  validSignature,
} from "./stripe";

export async function billingWebhook(db: CoreDb, request: Request, options: StripeOptions) {
  const raw = await request.text();
  if (!validSignature(raw, request.headers.get("stripe-signature") ?? "", options)) {
    throw new BillingError(400, "invalid_signature", "Invalid Stripe signature");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new BillingError(400, "bad_request", "Invalid event JSON");
    throw error;
  }
  const event = object(decoded);
  const id = string(event.id, "event id");
  const type = string(event.type, "event type");
  const value = object(object(event.data).object);
  const now = options.now();
  const eventAt = (
    typeof event.created === "number" ? new Date(event.created * 1000) : now
  ).toISOString();
  const stripe = stripeClient(options);
  const outgoing: EmailMessage[] = [];
  await db.transaction(async (tx) => {
    // The event claim and all effects commit together; failed handling can be retried.
    const claim = await tx
      .insert(stripeEvents)
      .values({ id, type, receivedAt: now.toISOString() })
      .onConflictDoNothing()
      .returning();
    if (claim.length === 0) return;
    await applyEvent({ tx, stripe, now, eventAt, options, outgoing }, type, value);
  });
  // Mail only after commit, so a retried event never emails twice.
  for (const message of outgoing) {
    try {
      await options.mailer?.send(message);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error(`mail ${message.template} to ${message.to} failed: ${error.message}`);
    }
  }
  return Response.json({ received: true });
}

type EventContext = {
  readonly tx: BillingTx;
  readonly stripe: StripeClient;
  readonly now: Date;
  readonly eventAt: string;
  readonly options: StripeOptions;
  readonly outgoing: EmailMessage[];
};

async function applyEvent(context: EventContext, type: string, value: Record<string, unknown>) {
  const { tx, stripe, now, eventAt, options, outgoing } = context;
  // Stripe event types are an open external string, not a closed domain union.
  if (
    [
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
    ].includes(type)
  ) {
    await subscriptionUpdate(context, value);
  } else if (type === "checkout.session.completed") {
    const details = object(value.customer_details ?? {});
    const buyerEmail = typeof details.email === "string" ? details.email : null;
    if (value.mode === "subscription") {
      const metadata = object(value.metadata);
      const farmId = string(metadata.farm_id, "farm_id");
      const customerId = string(value.customer, "customer");
      await tx
        .insert(billingCustomers)
        .values({ farmId, stripeCustomerId: customerId })
        .onConflictDoNothing();
      await subscriptionUpdate(
        context,
        await stripe(
          `subscriptions/${encodeURIComponent(string(value.subscription, "subscription"))}`,
        ),
      );
      if (buyerEmail && options.links) {
        outgoing.push(
          emails.planActive(
            options.links,
            buyerEmail,
            String(metadata.plan ?? ""),
            String(metadata.interval ?? ""),
          ),
        );
      }
    }
    await completedHardware(context, value);
  } else if (
    type === "checkout.session.async_payment_succeeded" ||
    type === "checkout.session.async_payment_failed"
  ) {
    const metadata = object(value.metadata ?? {});
    if (value.mode !== "payment" && Number(metadata.box ?? 0) + Number(metadata.cameras ?? 0) === 0)
      return;
    await hardwarePayment(context, { value, succeeded: type.endsWith("succeeded") });
  } else if (type === "invoice.payment_failed") {
    const parent = object(value.parent ?? {});
    const details = object(parent.subscription_details ?? {});
    const subscription = value.subscription ?? details.subscription;
    if (typeof subscription === "string") {
      await tx
        .update(farmSubscriptions)
        .set({ status: "past_due", updatedAt: now.toISOString(), stripeEventAt: eventAt })
        .where(
          sql`${farmSubscriptions.stripeSubscriptionId} = ${subscription} and (${farmSubscriptions.stripeEventAt} is null or ${farmSubscriptions.stripeEventAt} <= ${eventAt})`,
        );
    }
  }
}
