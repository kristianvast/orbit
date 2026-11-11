import type { FetchLike } from "../src/shape";

export function stripeFake(forms: URLSearchParams[]): FetchLike {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/customers") return Response.json({ id: "cus_test" });
    if (url.pathname === "/v1/prices")
      return Response.json({ data: [{ id: `price_${url.searchParams.get("lookup_keys[]")}` }] });
    if (url.pathname === "/v1/checkout/sessions") {
      forms.push(new URLSearchParams(String(init?.body)));
      return Response.json({ url: "https://checkout.stripe.test/combined" });
    }
    throw new TypeError(`Unexpected Stripe request ${url}`);
  };
}
