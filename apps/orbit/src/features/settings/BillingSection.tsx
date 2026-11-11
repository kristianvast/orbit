import "./providers.css";
import type { AccountStatus, BillingPlans, BillingStatus } from "@orbit/protocol";
import { Check, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, type BadgeVariant, Button, useToast } from "../../design";
import { type MessageKey, useI18n } from "../../i18n";
import { isTauriRuntime, useOrion } from "../../lib/orion";

export type PaidPlan = Exclude<BillingStatus["plan"], "free">;
export type BillingInterval = "month" | "year";

const DEFAULT_FREE_BILLING: BillingStatus = {
  plan: "free",
  interval: null,
  status: "inactive",
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  usage: { tokensUsed: 0, tokenAllowance: 0, voiceSecondsUsed: 0, voiceSecondsAllowance: 0 },
};

export async function openExternalUrl(url: string): Promise<void> {
  if (isTauriRuntime()) {
    try {
      const shell = await import("@tauri-apps/plugin-shell");
      await shell.open(url);
      return;
    } catch {
      // Fall back to window.open if shell plugin fails
    }
  }
  if (typeof window !== "undefined" && typeof window.open === "function") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function statusBadgeMeta(status: string): { variant: BadgeVariant; key: MessageKey } {
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

function UsageMeter({
  label,
  valueText,
  used,
  allowance,
  testId,
}: {
  readonly label: string;
  readonly valueText: string;
  readonly used: number;
  readonly allowance: number;
  readonly testId: string;
}) {
  const pct = allowance > 0 ? Math.min(100, Math.round((used / allowance) * 100)) : 0;
  const barColor =
    allowance > 0 && used >= allowance
      ? "var(--status-danger)"
      : pct >= 85
        ? "var(--status-warn)"
        : "var(--accent-primary)";

  return (
    <div className="orbit-billing__meter" data-testid={testId}>
      <div className="orbit-billing__meter-head">
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span className="orbit-billing__meter-val tabular-nums" data-testid={`${testId}-value`}>
          {valueText}
        </span>
      </div>
      <div
        className="orbit-billing__meter-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={allowance}
        aria-valuenow={used}
      >
        <div
          className="orbit-billing__meter-fill"
          style={{ inlineSize: `${pct}%`, backgroundColor: barColor }}
        />
      </div>
    </div>
  );
}

export interface BillingSectionProps {
  readonly status: AccountStatus;
  readonly now?: number;
}

export function BillingSection({ status, now = Date.now() }: BillingSectionProps) {
  const { t, formatNumber, formatDate } = useI18n();
  const { client } = useOrion();
  const { pushToast } = useToast();

  const [billing, setBilling] = useState<BillingStatus>(DEFAULT_FREE_BILLING);
  const [catalogue, setCatalogue] = useState<BillingPlans | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<PaidPlan>("orion");
  const [selectedInterval, setSelectedInterval] = useState<BillingInterval>("month");
  const [busyAction, setBusyAction] = useState<"checkout" | "portal" | null>(null);

  useEffect(() => {
    setCatalogue(null);
    setBilling(DEFAULT_FREE_BILLING);
    if (!client || status.state !== "signed_in") return;
    let live = true;
    client.request("billing.status", {}).then(
      (next) => {
        if (!live) return;
        setBilling(next);
        if (next.plan !== "free") setSelectedPlan(next.plan);
        if (next.interval === "month" || next.interval === "year")
          setSelectedInterval(next.interval);
      },
      () => {
        if (live) setBilling(DEFAULT_FREE_BILLING);
      },
    );
    client.request("billing.plans", {}).then(
      (next) => {
        if (live) setCatalogue(next);
      },
      () => {
        if (live) setCatalogue(null);
      },
    );
    return () => {
      live = false;
    };
  }, [client, status]);

  if (status.state === "unavailable") return null;

  if (status.state === "signed_out") {
    return (
      <div className="orbit-billing orbit-billing--signed-out" data-testid="billing-signed-out">
        <strong>{t("account.billing.title")}</strong>
        <p style={{ margin: 0, color: "var(--text-secondary)" }} data-testid="billing-free-copy">
          {t("account.billing.freeCopy")}
        </p>
        <p
          style={{ margin: 0, color: "var(--text-muted)", fontSize: "var(--text-sm)" }}
          data-testid="billing-signin-prompt"
        >
          {t("account.billing.signedOutPrompt")}
        </p>
      </div>
    );
  }

  const badge = statusBadgeMeta(billing.status);
  const voiceMinutesUsed = Math.round(billing.usage.voiceSecondsUsed / 60);
  const voiceMinutesAllowance = Math.round(billing.usage.voiceSecondsAllowance / 60);
  const paidPlans = catalogue?.plans.filter((plan) => plan.id !== "free") ?? [];
  const canPick =
    catalogue !== null &&
    !catalogue.locked &&
    paidPlans.length > 0 &&
    paidPlans.every((plan) => plan.monthly !== undefined && plan.yearly !== undefined);
  const activePlan = paidPlans.find((plan) => plan.id === selectedPlan) ?? paidPlans[0];
  const trialEnd = billing.trialEndsAt ? new Date(billing.trialEndsAt).getTime() : 0;
  const trialDays = billing.plan === "free" ? Math.ceil((trialEnd - now) / 86_400_000) : 0;

  const openBillingLink = async (kind: "checkout" | "portal") => {
    if (!client) return;
    if (kind === "checkout" && (!canPick || !activePlan || activePlan.id === "free")) return;
    setBusyAction(kind);
    try {
      const res =
        kind === "checkout"
          ? await client.request("billing.checkout", {
              plan: activePlan && activePlan.id !== "free" ? activePlan.id : selectedPlan,
              interval: selectedInterval,
            })
          : await client.request("billing.portal", {});
      await openExternalUrl(res.url);
    } catch (error) {
      pushToast({
        title: t("account.failed"),
        description: error instanceof Error ? error.message : String(error),
        tone: "danger",
      });
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="orbit-billing" data-testid="billing-section">
      <div className="orbit-billing__summary" data-testid="billing-summary">
        <div className="orbit-billing__summary-lead">
          <strong>{t("account.billing.title")}:</strong>
          <span style={{ fontWeight: 600 }} data-testid="billing-plan-name">
            {catalogue?.plans.find((plan) => plan.id === billing.plan)?.name ??
              t("account.billing.plan.unknown")}
          </span>
          <Badge variant={badge.variant} data-testid="billing-status-badge">
            {t(badge.key)}
          </Badge>
          {billing.interval && (
            <Badge variant="neutral" data-testid="billing-interval-badge">
              {t(`account.billing.interval.${billing.interval}`)}
            </Badge>
          )}
        </div>
        {billing.currentPeriodEnd && (
          <span
            className="tabular-nums"
            style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}
            data-testid="billing-period-end"
          >
            {t(
              billing.cancelAtPeriodEnd ? "account.billing.cancelsOn" : "account.billing.renewsOn",
              {
                date: formatDate(billing.currentPeriodEnd, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                }),
              },
            )}
          </span>
        )}
      </div>

      {trialDays > 0 && billing.trialEndsAt && (
        <p data-testid="billing-trial">
          {t("account.billing.trial", {
            count: trialDays,
            days: formatNumber(trialDays),
            date: formatDate(billing.trialEndsAt, {
              year: "numeric",
              month: "short",
              day: "numeric",
            }),
          })}
        </p>
      )}

      {billing.plan === "free" && (
        <p
          style={{ margin: 0, color: "var(--text-secondary)", fontSize: "var(--text-sm)" }}
          data-testid="billing-free-copy"
        >
          {t("account.billing.freeCopy")}
        </p>
      )}

      <div className="orbit-billing__grid" data-testid="billing-meters">
        <UsageMeter
          label={t("account.billing.tokensMeter")}
          valueText={t("account.billing.tokensUsage", {
            used: formatNumber(billing.usage.tokensUsed),
            allowance: formatNumber(billing.usage.tokenAllowance),
          })}
          used={billing.usage.tokensUsed}
          allowance={billing.usage.tokenAllowance}
          testId="billing-meter-tokens"
        />
        <UsageMeter
          label={t("account.billing.voiceMeter")}
          valueText={t("account.billing.voiceUsage", {
            used: formatNumber(voiceMinutesUsed),
            allowance: formatNumber(voiceMinutesAllowance),
          })}
          used={voiceMinutesUsed}
          allowance={voiceMinutesAllowance}
          testId="billing-meter-voice"
        />
      </div>

      {canPick ? (
        <div
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
          data-testid="billing-picker"
        >
          <div className="orbit-billing__picker-head">
            <span style={{ fontSize: "var(--text-sm)", fontWeight: 600 }}>
              {t("account.billing.pickerPlanLabel")}
            </span>
            <fieldset
              className="orbit-billing__intervals"
              aria-label={t("account.billing.pickerIntervalLabel")}
            >
              {(["month", "year"] as const).map((interval) => (
                <Button
                  key={interval}
                  type="button"
                  size="sm"
                  variant={selectedInterval === interval ? "primary" : "secondary"}
                  aria-pressed={selectedInterval === interval}
                  onClick={() => setSelectedInterval(interval)}
                  data-testid={`billing-interval-${interval}`}
                >
                  {t(`account.billing.interval.${interval}`)}
                </Button>
              ))}
            </fieldset>
          </div>

          <fieldset
            className="orbit-billing__grid"
            aria-label={t("account.billing.pickerPlanLabel")}
          >
            {paidPlans.map((plan) => {
              const id = plan.id;
              if (id === "free") return null;
              const selected = activePlan?.id === plan.id;
              const price = selectedInterval === "month" ? plan.monthly : plan.yearly;
              if (price === undefined) return null;
              return (
                <button
                  key={plan.id}
                  type="button"
                  className="orbit-billing__plan-btn"
                  aria-pressed={selected}
                  onClick={() => setSelectedPlan(id)}
                  data-testid={`billing-plan-${plan.id}`}
                >
                  <span className="orbit-billing__plan-title">
                    {selected && (
                      <Check
                        size={15}
                        style={{ color: "var(--accent-primary)" }}
                        aria-hidden="true"
                      />
                    )}
                    {plan.name}
                  </span>
                  <span className="orbit-billing__plan-desc">
                    {t(`account.billing.option.${selectedInterval}`, {
                      name: plan.name,
                      price: formatNumber(price, { style: "currency", currency: "EUR" }),
                      tokens: formatNumber(plan.orionTokens),
                      minutes: formatNumber(plan.voiceMinutes),
                    })}
                  </span>
                </button>
              );
            })}
          </fieldset>

          <div className="orbit-billing__actions">
            <Button
              type="button"
              variant="primary"
              size="sm"
              loading={busyAction === "checkout"}
              icon={<ExternalLink size={14} />}
              onClick={() => void openBillingLink("checkout")}
              data-testid="billing-checkout-button"
            >
              {t("account.billing.choosePlan")}
            </Button>
          </div>
        </div>
      ) : (
        <a
          href="https://pecorva.com/pricing/"
          target="_blank"
          rel="noreferrer"
          data-testid="billing-pricing-link"
        >
          {t("account.billing.websitePricing")}
        </a>
      )}
      {billing.plan !== "free" && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={busyAction === "portal"}
          icon={<ExternalLink size={14} />}
          onClick={() => void openBillingLink("portal")}
          data-testid="billing-portal-button"
        >
          {t("account.billing.manageBilling")}
        </Button>
      )}
    </div>
  );
}
