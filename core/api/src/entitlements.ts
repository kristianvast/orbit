import { and, asc, eq, gte, sql } from "drizzle-orm";
import {
  type CoreDb,
  farmBudgets,
  farmMembers,
  farmSubscriptions,
  llmUsage,
  users,
  voiceUsage,
} from "./db";
import { planFor, trialDays } from "./plans";

export const PLAN_REQUIRED = {
  error: {
    code: "plan_required",
    message:
      "Your free Orion month has ended. An Orion or camera plan, or your own model key in Settings, keeps Orion running.",
  },
} as const;

export const EMAIL_REQUIRED = {
  error: {
    code: "plan_required",
    message:
      "Confirm your email address to start your free Orion month. An Orion or camera plan, or your own model key in Settings, also keeps Orion running.",
  },
} as const;

/** The 402 body for a farm without cloud Orion: the address is unconfirmed, or the month is over. */
export function planRequired(entitlement: { readonly trialNeedsEmail: boolean }) {
  return entitlement.trialNeedsEmail ? EMAIL_REQUIRED : PLAN_REQUIRED;
}

export function monthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export type BillingAccount = {
  readonly kind: "farm" | "personal";
  readonly id: string;
};

export async function entitlements(db: CoreDb, account: string | BillingAccount, now: Date) {
  const farmId = typeof account === "string" ? account : account.id;
  const [subscription] = await db
    .select()
    .from(farmSubscriptions)
    .where(eq(farmSubscriptions.farmId, farmId));
  const active =
    subscription?.plan !== "free" &&
    (subscription?.status === "active" || subscription?.status === "trialing");
  const plan = planFor(active ? subscription.plan : "free");
  const [owner] = active
    ? []
    : typeof account !== "string" && account.kind === "personal"
      ? await db
          .select({ createdAt: users.createdAt, verifiedAt: users.emailVerifiedAt })
          .from(users)
          .where(eq(users.id, account.id))
          .limit(1)
      : await db
          .select({ createdAt: users.createdAt, verifiedAt: users.emailVerifiedAt })
          .from(farmMembers)
          .innerJoin(users, eq(users.id, farmMembers.userId))
          .where(and(eq(farmMembers.farmId, farmId), eq(farmMembers.role, "owner")))
          .orderBy(asc(users.createdAt))
          .limit(1);
  const trialEnd = owner
    ? new Date(new Date(owner.createdAt).getTime() + trialDays * 86_400_000)
    : null;
  const inFreeMonth = trialEnd !== null && now < trialEnd;
  // The month only counts for a confirmed address, so a scripted sign-up never reaches the model.
  const trialNeedsEmail = inFreeMonth && !owner?.verifiedAt;
  const trialEndsAt = inFreeMonth && !trialNeedsEmail ? trialEnd.toISOString() : null;
  const allowance = trialEndsAt ? planFor("orion") : plan;
  const [override] = await db.select().from(farmBudgets).where(eq(farmBudgets.farmId, farmId));
  return {
    subscription,
    plan,
    trialEndsAt,
    trialNeedsEmail,
    usageStart: trialEndsAt && owner ? owner.createdAt : monthStart(now),
    tokenAllowance: override?.monthlyTokenBudget ?? allowance.orionTokens,
    voiceSecondsAllowance: allowance.voiceMinutes * 60,
  };
}

export async function usageThisMonth(db: CoreDb, accountId: string, window: Date | string) {
  const since = typeof window === "string" ? window : monthStart(window);
  const [[tokens], [voice]] = await Promise.all([
    db
      .select({ used: sql<string>`coalesce(sum(${llmUsage.totalTokens}), 0)` })
      .from(llmUsage)
      .where(and(eq(llmUsage.accountId, accountId), gte(llmUsage.createdAt, since))),
    db
      .select({ used: sql<string>`coalesce(sum(${voiceUsage.seconds}), 0)` })
      .from(voiceUsage)
      .where(and(eq(voiceUsage.accountId, accountId), gte(voiceUsage.createdAt, since))),
  ]);
  return { tokensUsed: Number(tokens?.used ?? 0), voiceSecondsUsed: Number(voice?.used ?? 0) };
}
