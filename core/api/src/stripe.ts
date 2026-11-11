import { createHmac, timingSafeEqual } from "node:crypto";
import type { EmailLinks, Mailer } from "./mailer";
import type { FetchLike } from "./shape";

export class BillingError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BillingError(400, "bad_request", "expected a JSON object");
  }
  return Object.fromEntries(Object.entries(value));
}

export function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value)
    throw new BillingError(400, "bad_request", `${field} is required`);
  return value;
}

export interface StripeOptions {
  readonly secretKey?: string;
  readonly webhookSecret?: string;
  readonly successUrl?: string;
  readonly cancelUrl?: string;
  /** Website origins a client-supplied redirect may point at, besides the two URLs above. */
  readonly redirectOrigins?: readonly string[];
  /** Stripe Tax must be activated (origin address, registrations) before turning this on. */
  readonly automaticTax?: boolean;
  readonly mailer?: Mailer;
  readonly links?: EmailLinks;
  /** Receives a notice for every paid hardware order so it can be packed and shipped. */
  readonly ordersEmail?: string;
  readonly fetch: FetchLike;
  readonly now: () => Date;
}

export function stripeClient(options: StripeOptions) {
  return async (path: string, form?: URLSearchParams, idempotencyKey?: string) => {
    if (!options.secretKey)
      throw new BillingError(503, "not_configured", "Stripe is not configured");
    const headers = new Headers({ authorization: `Bearer ${options.secretKey}` });
    if (form) headers.set("content-type", "application/x-www-form-urlencoded");
    if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
    const response = await options.fetch(`https://api.stripe.com/v1/${path}`, {
      method: form ? "POST" : "GET",
      headers,
      body: form?.toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const data = object(await response.json());
    if (!response.ok) throw new BillingError(502, "stripe_error", "Stripe request failed");
    return data;
  };
}

export type StripeClient = ReturnType<typeof stripeClient>;

export async function priceFor(stripe: StripeClient, lookup: string): Promise<string> {
  const prices = await stripe(
    `prices?${new URLSearchParams({ "lookup_keys[]": lookup, active: "true" })}`,
  );
  if (!Array.isArray(prices.data) || prices.data.length !== 1) {
    throw new BillingError(503, "price_missing", `Run stripe:setup for ${lookup}`);
  }
  return string(object(prices.data[0]).id, "price id");
}

export function validSignature(raw: string, header: string, options: StripeOptions): boolean {
  if (!options.webhookSecret) return false;
  const parts = header.split(",").map((part) => part.trim().split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1] ?? "";
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(options.now().getTime() / 1000 - Number(timestamp)) > 300
  )
    return false;
  const expected = createHmac("sha256", options.webhookSecret)
    .update(`${timestamp}.${raw}`)
    .digest();
  return parts.some(
    ([key, value]) =>
      key === "v1" &&
      typeof value === "string" &&
      /^[a-f0-9]{64}$/i.test(value) &&
      timingSafeEqual(expected, Buffer.from(value, "hex")),
  );
}
