import { eq, sql } from "drizzle-orm";
import {
  billingCustomers,
  type CoreDb,
  farmSubscriptions,
  hardwareOrders,
  stripeEvents,
} from "./db";
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

type BillingTx = Parameters<Parameters<CoreDb["transaction"]>[0]>[0];

async function subscriptionUpdate(
  tx: BillingTx,
  value: Record<string, unknown>,
  now: Date,
  eventAt: string,
) {
  const metadata = object(value.metadata ?? {});
  // The customer link wins over metadata: a farm adopted by an Orbit install keeps the Stripe
  // customer but gets a new farm id, while the subscription metadata still names the old one.
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
  const key = typeof price.lookup_key === "string" ? price.lookup_key : "";
  const plan =
    metadata.plan ?? (key.includes("_barn_") ? "barn" : key.includes("_pen_") ? "pen" : undefined);
  const interval = metadata.interval ?? recurring.interval;
  if ((plan !== "pen" && plan !== "barn") || (interval !== "month" && interval !== "year")) {
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
  // Stripe does not guarantee delivery order; an older event never overwrites newer state.
  await tx
    .insert(farmSubscriptions)
    .values(row)
    .onConflictDoUpdate({
      target: farmSubscriptions.farmId,
      set: row,
      setWhere: sql`${farmSubscriptions.stripeEventAt} is null or ${farmSubscriptions.stripeEventAt} <= ${eventAt}`,
    });
}

function shippingOf(value: Record<string, unknown>): unknown {
  const collected = object(value.collected_information ?? {});
  return collected.shipping_details ?? value.shipping_details ?? null;
}

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
  const eventAt = (
    typeof event.created === "number" ? new Date(event.created * 1000) : options.now()
  ).toISOString();
  const stripe = stripeClient(options);
  const outgoing: EmailMessage[] = [];
  await db.transaction(async (tx) => {
    // The event claim and all effects commit together; failed handling can be retried.
    const claim = await tx
      .insert(stripeEvents)
      .values({ id, type, receivedAt: options.now().toISOString() })
      .onConflictDoNothing()
      .returning();
    if (claim.length === 0) return;
    await applyEvent({ tx, stripe, now: options.now(), eventAt, options, outgoing }, type, value);
  });
  // Mail only after the commit, so a retried event never emails twice.
  for (const message of outgoing) {
    try {
      await options.mailer?.send(message);
    } catch (error) {
      console.error(
        `mail ${message.template} to ${message.to} failed: ${(error as Error).message}`,
      );
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

function hardwareMails(
  context: EventContext,
  email: string | null,
  sessionId: string,
  boxes: number,
  cameras: number,
) {
  const { options, outgoing } = context;
  if (email && options.links) {
    outgoing.push(emails.hardwareOrder(options.links, email, boxes, cameras));
  }
  if (options.ordersEmail) {
    outgoing.push(emails.orderNotice(options.ordersEmail, sessionId, boxes, cameras, email));
  }
}

async function applyEvent(context: EventContext, type: string, value: Record<string, unknown>) {
  const { tx, stripe, now, eventAt, options, outgoing } = context;
  // Stripe's event type is an open external string, not a closed domain union.
  if (type.startsWith("customer.subscription.")) {
    if (
      [
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
      ].includes(type)
    ) {
      await subscriptionUpdate(tx, value, now, eventAt);
    }
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
        tx,
        await stripe(
          `subscriptions/${encodeURIComponent(string(value.subscription, "subscription"))}`,
        ),
        now,
        eventAt,
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
    } else if (value.mode === "payment") {
      const metadata = object(value.metadata ?? {});
      const sessionId = string(value.id, "session id");
      const boxes = Number(metadata.box ?? 0);
      const cameras = Number(metadata.cameras ?? 0);
      const paid =
        value.payment_status === "paid" || value.payment_status === "no_payment_required";
      const inserted = await tx
        .insert(hardwareOrders)
        .values({
          stripeCheckoutSessionId: sessionId,
          email: buyerEmail,
          boxes,
          cameras,
          status: paid ? "paid" : "pending",
          userId: typeof metadata.user_id === "string" ? metadata.user_id : null,
          shipping: shippingOf(value),
          amountTotal: typeof value.amount_total === "number" ? value.amount_total : null,
          currency: typeof value.currency === "string" ? value.currency : null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        })
        .onConflictDoNothing()
        .returning();
      if (paid && inserted.length > 0)
        hardwareMails(context, buyerEmail, sessionId, boxes, cameras);
    }
  } else if (
    type === "checkout.session.async_payment_succeeded" ||
    type === "checkout.session.async_payment_failed"
  ) {
    if (value.mode !== "payment") return;
    const sessionId = string(value.id, "session id");
    const status = type.endsWith("succeeded") ? "paid" : "failed";
    const [order] = await tx
      .update(hardwareOrders)
      .set({ status, updatedAt: now.toISOString() })
      .where(eq(hardwareOrders.stripeCheckoutSessionId, sessionId))
      .returning();
    if (!order) throw new BillingError(409, "order_missing", "Order not recorded yet; retry");
    if (status === "paid")
      hardwareMails(context, order.email, sessionId, order.boxes, order.cameras);
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
