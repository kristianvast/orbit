import { and, eq, gte, sql } from "drizzle-orm";
import { type CoreDb, farmBudgets, farmSubscriptions, llmUsage, voiceUsage } from "./db";
import { planFor } from "./plans";

export const PLAN_REQUIRED = {
  error: {
    code: "plan_required",
    message:
      "Orion on Pecorva's cloud is included with a pen or barn plan. On the free plan, add your own model key in Settings.",
  },
} as const;

export function monthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export async function entitlements(db: CoreDb, farmId: string) {
  const [subscription] = await db
    .select()
    .from(farmSubscriptions)
    .where(eq(farmSubscriptions.farmId, farmId));
  const active = subscription?.status === "active" || subscription?.status === "trialing";
  const plan = planFor(active ? subscription.plan : "free");
  const [override] = await db.select().from(farmBudgets).where(eq(farmBudgets.farmId, farmId));
  return {
    subscription,
    plan,
    tokenAllowance: override?.monthlyTokenBudget ?? plan.orionTokens,
    voiceSecondsAllowance: plan.voiceMinutes * 60,
  };
}

export async function usageThisMonth(db: CoreDb, farmId: string, now: Date) {
  const since = monthStart(now);
  const [[tokens], [voice]] = await Promise.all([
    db
      .select({ used: sql<string>`coalesce(sum(${llmUsage.totalTokens}), 0)` })
      .from(llmUsage)
      .where(and(eq(llmUsage.farmId, farmId), gte(llmUsage.createdAt, since))),
    db
      .select({ used: sql<string>`coalesce(sum(${voiceUsage.seconds}), 0)` })
      .from(voiceUsage)
      .where(and(eq(voiceUsage.farmId, farmId), gte(voiceUsage.createdAt, since))),
  ]);
  return { tokensUsed: Number(tokens?.used ?? 0), voiceSecondsUsed: Number(voice?.used ?? 0) };
}
