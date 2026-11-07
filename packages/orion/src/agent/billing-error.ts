export function billingError(message: string): {
  readonly code: "plan_required" | "budget_exceeded";
  readonly message: string;
} | null {
  if (/plan_required|\b402\b/i.test(message)) {
    return {
      code: "plan_required",
      message:
        "Choose a plan to use Orion on Pecorva's cloud, or use your own AI key in Providers.",
    };
  }
  if (/budget_exceeded|\b429\b/i.test(message)) {
    return {
      code: "budget_exceeded",
      message:
        "Your Orion allowance is used up for this period. Use your own AI key or manage your plan.",
    };
  }
  return null;
}
