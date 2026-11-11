import { and, eq, ne } from "drizzle-orm";
import { hardwareSelection } from "./billing-checkout";
import type { BillingTx } from "./billing-subscription";
import { hardwareOrders } from "./db";
import { type EmailMessage, emails } from "./mailer";
import { BillingError, object, type StripeOptions, string } from "./stripe";

type OrderContext = {
  readonly tx: BillingTx;
  readonly now: Date;
  readonly options: StripeOptions;
  readonly outgoing: EmailMessage[];
};

function hardwareMails(context: OrderContext, order: typeof hardwareOrders.$inferSelect) {
  if (order.email && context.options.links)
    context.outgoing.push(
      emails.hardwareOrder(context.options.links, order.email, order.boxes, order.cameras),
    );
  if (context.options.ordersEmail)
    context.outgoing.push(
      emails.orderNotice(
        context.options.ordersEmail,
        order.stripeCheckoutSessionId,
        order.boxes,
        order.cameras,
        order.email,
      ),
    );
}

export async function completedHardware(context: OrderContext, value: Record<string, unknown>) {
  const { tx, now } = context;
  const metadata = object(value.metadata ?? {});
  const { box, cameras } = hardwareSelection({
    box: Number(metadata.box ?? 0),
    cameras: Number(metadata.cameras ?? 0),
  });
  if (box + cameras === 0) return;
  const details = object(value.customer_details ?? {});
  const collected = object(value.collected_information ?? {});
  const paid = value.payment_status === "paid" || value.payment_status === "no_payment_required";
  const [order] = await tx
    .insert(hardwareOrders)
    .values({
      stripeCheckoutSessionId: string(value.id, "session id"),
      email: typeof details.email === "string" ? details.email : null,
      boxes: box,
      cameras,
      status: paid ? "paid" : "pending",
      userId: typeof metadata.user_id === "string" ? metadata.user_id : null,
      shipping: collected.shipping_details ?? value.shipping_details ?? null,
      amountTotal: typeof value.amount_total === "number" ? value.amount_total : null,
      currency: typeof value.currency === "string" ? value.currency : null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })
    .onConflictDoNothing()
    .returning();
  if (paid && order) hardwareMails(context, order);
}

export async function hardwarePayment(
  context: OrderContext,
  event: {
    readonly value: Record<string, unknown>;
    readonly succeeded: boolean;
  },
) {
  const sessionId = string(event.value.id, "session id");
  const [order] = await context.tx
    .update(hardwareOrders)
    .set({ status: event.succeeded ? "paid" : "failed", updatedAt: context.now.toISOString() })
    .where(
      and(eq(hardwareOrders.stripeCheckoutSessionId, sessionId), ne(hardwareOrders.status, "paid")),
    )
    .returning();
  if (order) {
    if (event.succeeded) hardwareMails(context, order);
    return;
  }
  const [existing] = await context.tx
    .select()
    .from(hardwareOrders)
    .where(eq(hardwareOrders.stripeCheckoutSessionId, sessionId));
  if (!existing) throw new BillingError(409, "order_missing", "Order not recorded yet; retry");
}
