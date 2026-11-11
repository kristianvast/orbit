export const plans = [
  { id: "free", name: "Free", cameras: 0, monthly: 0, yearly: 0, orionTokens: 0, voiceMinutes: 0 },
  {
    id: "orion",
    name: "Orion",
    cameras: 0,
    monthly: 20,
    yearly: 200,
    orionTokens: 2_000_000,
    voiceMinutes: 30,
  },
  {
    id: "cam2",
    name: "2 cameras",
    cameras: 2,
    monthly: 49,
    yearly: 490,
    orionTokens: 3_000_000,
    voiceMinutes: 60,
  },
  {
    id: "cam4",
    name: "4 cameras",
    cameras: 4,
    monthly: 75,
    yearly: 750,
    orionTokens: 5_000_000,
    voiceMinutes: 100,
  },
  {
    id: "cam6",
    name: "6 cameras",
    cameras: 6,
    monthly: 95,
    yearly: 950,
    orionTokens: 8_000_000,
    voiceMinutes: 150,
  },
] as const;

export const hardware = [
  { id: "box", name: "Pecorva box", price: 920, lookupKey: "pecorva_box" },
  { id: "camera", name: "Tested camera", price: 150, lookupKey: "pecorva_camera" },
] as const;

export type PlanId = (typeof plans)[number]["id"];
export type PaidPlanId = Exclude<PlanId, "free">;
export type BillingInterval = "month" | "year";
export const currency = "eur";
export const trialDays = 30;
export const lookupKey = (plan: PaidPlanId, interval: BillingInterval) =>
  `pecorva_${plan}_${interval === "month" ? "monthly" : "yearly"}`;

export function isPaidPlan(id: unknown): id is PaidPlanId {
  return plans.some((plan) => plan.id !== "free" && plan.id === id);
}

export function planFor(id: string) {
  return plans.find((plan) => plan.id === id) ?? plans[0];
}
