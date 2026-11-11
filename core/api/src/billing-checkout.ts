import { resolveSession } from "./auth";
import type { CoreDb } from "./db";
import { currency, hardware } from "./plans";
import {
  BillingError,
  object,
  priceFor,
  type StripeClient,
  type StripeOptions,
  string,
  stripeClient,
} from "./stripe";

const SHIPPING_COUNTRIES = [
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
] as const;

/** The configured redirects and the website origins: the only places Stripe may send a buyer back to. */
function redirectOrigins(options: StripeOptions): Set<string> {
  const origins = new Set<string>();
  for (const allowed of [
    options.successUrl,
    options.cancelUrl,
    ...(options.redirectOrigins ?? []),
  ]) {
    if (allowed && URL.canParse(allowed)) origins.add(new URL(allowed).origin);
  }
  return origins;
}

export function redirectUrl(
  value: unknown,
  fallback: string | undefined,
  options: StripeOptions,
): string {
  const supplied = value !== undefined && value !== null;
  const text = string(supplied ? value : fallback, "redirect URL");
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
  // A link to Stripe that returns the buyer to a stranger's site is a phishing tool.
  if (supplied && !redirectOrigins(options).has(url.origin))
    throw new BillingError(400, "bad_request", "Redirect URL must point at the Pecorva website");
  return url.href;
}

/** Stripe Tax, VAT number collection and a billing address on every Checkout Session. */
export function addTaxFields(form: URLSearchParams, options: StripeOptions) {
  if (!options.automaticTax) return;
  form.set("automatic_tax[enabled]", "true");
  form.set("tax_id_collection[enabled]", "true");
  form.set("billing_address_collection", "required");
}

export function hardwareSelection(body: Record<string, unknown>) {
  const box = body.box === undefined ? 0 : body.box;
  const cameras = body.cameras === undefined ? 0 : body.cameras;
  if (
    typeof box !== "number" ||
    typeof cameras !== "number" ||
    !Number.isSafeInteger(box) ||
    !Number.isSafeInteger(cameras) ||
    box < 0 ||
    cameras < 0 ||
    box > 20 ||
    cameras > 64
  )
    throw new BillingError(
      400,
      "bad_request",
      "Choose whole hardware quantities within the order limits",
    );
  return { box, cameras } as const;
}

export async function addHardware(
  form: URLSearchParams,
  selection: ReturnType<typeof hardwareSelection>,
  stripe: StripeClient,
) {
  if (selection.box + selection.cameras === 0) return;
  let index = form.get("mode") === "subscription" ? 1 : 0;
  for (const [item, quantity] of [
    [hardware[0], selection.box],
    [hardware[1], selection.cameras],
  ] as const) {
    if (quantity === 0) continue;
    form.set(`line_items[${index}][price]`, await priceFor(stripe, item.lookupKey));
    form.set(`line_items[${index}][quantity]`, String(quantity));
    index++;
  }
  form.set("metadata[box]", String(selection.box));
  form.set("metadata[cameras]", String(selection.cameras));
  for (const [index, country] of SHIPPING_COUNTRIES.entries()) {
    form.set(`shipping_address_collection[allowed_countries][${index}]`, country);
  }
  if (form.get("mode") === "subscription") form.set("customer_update[shipping]", "auto");
}

export async function hardwareCheckout(db: CoreDb, request: Request, options: StripeOptions) {
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]?.trim();
  const buyer = bearer ? await resolveSession(db, bearer, options.now()) : null;
  if (!buyer) throw new BillingError(401, "unauthorized", "Sign in first");
  const body = object(await request.json());
  const selection = hardwareSelection(body);
  if (selection.box + selection.cameras === 0)
    throw new BillingError(400, "bad_request", "Choose a positive number of boxes or cameras");
  const form = new URLSearchParams({
    mode: "payment",
    currency,
    success_url: redirectUrl(body.successUrl, options.successUrl, options),
    cancel_url: redirectUrl(body.cancelUrl, options.cancelUrl, options),
    customer_creation: "always",
    "invoice_creation[enabled]": "true",
    "metadata[user_id]": buyer.id,
    customer_email: buyer.email,
  });
  addTaxFields(form, options);
  const stripe = stripeClient(options);
  await addHardware(form, selection, stripe);
  const session = await stripe("checkout/sessions", form);
  return Response.json({ url: string(session.url, "checkout URL") });
}
