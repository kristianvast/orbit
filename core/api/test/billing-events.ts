import { createHmac } from "node:crypto";
import { type billingFixture, FARM, NOW, SECRET } from "./billing-fixture";
export function signed(payload: string, timestamp = Math.floor(NOW.getTime() / 1000)) {
  const signature = createHmac("sha256", SECRET).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}
export const subscription = {
  id: "sub_test",
  customer: "cus_test",
  metadata: { farm_id: FARM, plan: "cam2", interval: "month" },
  status: "active",
  current_period_end: 1796644800,
  cancel_at_period_end: true,
};
export async function webhook(
  a: ReturnType<ReturnType<typeof billingFixture>["app"]>,
  options: {
    readonly id?: string;
    readonly signature?: string;
    readonly value?: object;
    readonly type?: string;
    readonly created?: number;
  } = {},
) {
  const payload = JSON.stringify({
    id: options.id ?? "evt_test",
    type: options.type ?? "customer.subscription.updated",
    ...(options.created === undefined ? {} : { created: options.created }),
    data: { object: options.value ?? subscription },
  });
  return a.request("/v1/billing/webhook", {
    method: "POST",
    headers: { "stripe-signature": options.signature ?? signed(payload) },
    body: payload,
  });
}
