import { canManageMembers } from "@orbit/schema";
import type { Principal } from "./auth";
import { memberFarmTokens, resolveBillingAccount } from "./billing-account";
import type { CoreDb } from "./db";
import { type BillingAccount, entitlements, usageThisMonth } from "./entitlements";
import { BillingError } from "./stripe";

export function checkoutAccount(principal: Principal, choice: unknown): BillingAccount {
  if (choice !== undefined && choice !== "farm" && choice !== "personal")
    throw new BillingError(400, "bad_request", "account must be farm or personal");
  const kind =
    choice ?? (principal.farmId && canManageMembers(principal.role) ? "farm" : "personal");
  if (kind === "farm") {
    if (!principal.farmId || !canManageMembers(principal.role))
      throw new BillingError(403, "forbidden", "Only owners and managers manage farm billing");
    return { kind, id: principal.farmId };
  }
  if (!principal.userId) throw new BillingError(401, "unauthorized", "Sign in first");
  return { kind: "personal", id: principal.userId };
}

export async function billingStatus(db: CoreDb, principal: Principal, now: Date) {
  const effective = await resolveBillingAccount(
    db,
    {
      farmId: principal.farmId || null,
      userId: principal.userId,
    },
    now,
  );
  const summary = async (account: BillingAccount) => {
    const entitlement = await entitlements(db, account, now);
    const usage = await usageThisMonth(db, account.id, entitlement.usageStart);
    return {
      plan: entitlement.plan.id,
      trialEndsAt: entitlement.trialEndsAt,
      tokensUsed: usage.tokensUsed,
      tokenAllowance: entitlement.tokenAllowance,
    };
  };
  const { subscription, plan, tokenAllowance, voiceSecondsAllowance, trialEndsAt, usageStart } =
    effective.entitlement;
  return {
    plan: plan.id,
    trialEndsAt,
    interval: subscription?.interval ?? null,
    status: subscription?.status ?? "free",
    currentPeriodEnd: subscription?.currentPeriodEnd
      ? new Date(subscription.currentPeriodEnd).toISOString()
      : null,
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    usage: {
      ...(await usageThisMonth(db, effective.id, usageStart)),
      tokenAllowance,
      voiceSecondsAllowance,
    },
    account: effective.kind,
    usageSource: effective.member?.usageSource ?? null,
    farmPlanAllowed: effective.member?.useFarmPlan ?? false,
    member: effective.member
      ? {
          tokensUsed: await memberFarmTokens(db, effective.member, now),
          tokenLimit: effective.member.monthlyTokenLimit,
        }
      : null,
    personal: await summary(checkoutAccount(principal, "personal")),
    farm: principal.farmId ? await summary({ kind: "farm", id: principal.farmId }) : null,
  };
}
