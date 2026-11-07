export const plans = [
  { id: "free", name: "Free", monthly: 0, yearly: 0, orionTokens: 0, voiceMinutes: 0 },
  { id: "pen", name: "Pen", monthly: 49, yearly: 490, orionTokens: 3_000_000, voiceMinutes: 60 },
  {
    id: "barn",
    name: "Barn",
    monthly: 189,
    yearly: 1890,
    orionTokens: 15_000_000,
    voiceMinutes: 300,
  },
] as const;

export const hardware = [
  { id: "box", name: "Pecorva box", price: 920, lookupKey: "pecorva_box" },
  { id: "camera", name: "Tested camera", price: 150, lookupKey: "pecorva_camera" },
] as const;

export type PlanId = (typeof plans)[number]["id"];
export type BillingInterval = "month" | "year";
export const currency = "eur";
export const lookupKey = (plan: "pen" | "barn", interval: BillingInterval) =>
  `pecorva_${plan}_${interval === "month" ? "monthly" : "yearly"}`;

export function planFor(id: string) {
  return plans.find((plan) => plan.id === id) ?? plans[0];
}
