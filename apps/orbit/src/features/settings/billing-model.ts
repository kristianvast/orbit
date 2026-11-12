import type {
  AccountStatus,
  BillingAccount,
  BillingStatus,
  RequestParams,
  UsageSource,
} from "@orbit/protocol";
import { canManageMembers } from "@orbit/schema/roles";
import type { BadgeVariant } from "../../design";
import type { MessageKey } from "../../i18n";
import { isTauriRuntime } from "../../lib/orion";

export const PRICING_URL = "https://pecorva.com/pricing/";

export const DEFAULT_FREE_BILLING: BillingStatus = {
  plan: "free",
  interval: null,
  status: "inactive",
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  usage: { tokensUsed: 0, tokenAllowance: 0, voiceSecondsUsed: 0, voiceSecondsAllowance: 0 },
};

export async function openExternalUrl(url: string): Promise<void> {
  if (isTauriRuntime()) {
    const shell = await import("@tauri-apps/plugin-shell");
    await shell.open(url);
    return;
  }
  if (typeof window !== "undefined" && typeof window.open === "function") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export function statusBadgeMeta(status: string): { variant: BadgeVariant; key: MessageKey } {
  switch (status) {
    case "active":
      return { variant: "ok", key: "account.billing.status.active" };
    case "trialing":
      return { variant: "info", key: "account.billing.status.trialing" };
    case "past_due":
      return { variant: "warn", key: "account.billing.status.past_due" };
    case "canceled":
      return { variant: "neutral", key: "account.billing.status.canceled" };
    default:
      return { variant: "neutral", key: "account.billing.status.inactive" };
  }
}

export function hasMultiUserBilling(billing: BillingStatus): boolean {
  return (
    billing.account !== undefined ||
    billing.usageSource !== undefined ||
    billing.farmPlanAllowed !== undefined ||
    billing.personal !== undefined ||
    billing.farm !== undefined ||
    billing.member !== undefined
  );
}

export function resolveUsageChoice(billing: BillingStatus): UsageSource {
  if (billing.farmPlanAllowed === false) return "own";
  if (billing.usageSource === "own" || billing.usageSource === "farm") {
    return billing.usageSource;
  }
  return billing.account === "personal" ? "own" : "farm";
}

export function resolveBillingAccount(
  status: AccountStatus,
  billing: BillingStatus,
): BillingAccount | null {
  if (!status.farm || resolveUsageChoice(billing) === "own") {
    return "personal";
  }
  return canManageMembers(status.farm.role) ? "farm" : null;
}

export function buildCheckoutParams(
  plan: RequestParams<"billing.checkout">["plan"],
  interval: RequestParams<"billing.checkout">["interval"],
  status: AccountStatus,
  billing: BillingStatus,
): RequestParams<"billing.checkout"> | null {
  const account = resolveBillingAccount(status, billing);
  if (!account) return null;
  if (!hasMultiUserBilling(billing) && account === "farm") {
    return { plan, interval };
  }
  return { plan, interval, account };
}

export function buildPortalParams(
  status: AccountStatus,
  billing: BillingStatus,
): RequestParams<"billing.portal"> | null {
  if (!hasMultiUserBilling(billing)) {
    if (billing.plan === "free") return null;
    if (!status.farm) return { account: "personal" };
    return canManageMembers(status.farm.role) ? {} : null;
  }

  const account = resolveBillingAccount(status, billing);
  if (account === "personal") {
    const plan = billing.personal ? billing.personal.plan : billing.plan;
    return plan !== "free" ? { account: "personal" } : null;
  }
  if (account === "farm") {
    const plan = billing.farm ? billing.farm.plan : billing.plan;
    return plan !== "free" ? { account: "farm" } : null;
  }
  return null;
}
