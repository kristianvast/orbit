import "./providers.css";
import type { AccountStatus, BillingPlans, BillingStatus } from "@orbit/protocol";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, type BadgeVariant, Button, useToast } from "../../design";
import { type MessageKey, useI18n } from "../../i18n";
import { isTauriRuntime, useOrion } from "../../lib/orion";

/** Plans are chosen on the website, in the browser; the app only shows the current one. */
export const PRICING_URL = "https://pecorva.com/pricing/";

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
    // Always the system browser: window.open in the desktop app would show the page inside Orbit.
    const shell = await import("@tauri-apps/plugin-shell");
    await shell.open(url);
    return;
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
  const [busyPortal, setBusyPortal] = useState(false);

  useEffect(() => {
    setCatalogue(null);
    setBilling(DEFAULT_FREE_BILLING);
    if (!client || status.state !== "signed_in") return;
    let live = true;
    client.request("billing.status", {}).then(
      (next) => {
        if (live) setBilling(next);
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
  const trialEnd = billing.trialEndsAt ? new Date(billing.trialEndsAt).getTime() : 0;
  const trialDays = billing.plan === "free" ? Math.ceil((trialEnd - now) / 86_400_000) : 0;

  const openPortal = async () => {
    if (!client) return;
    setBusyPortal(true);
    try {
      const res = await client.request("billing.portal", {});
      await openExternalUrl(res.url);
    } catch (error) {
      pushToast({
        title: t("account.failed"),
        description: error instanceof Error ? error.message : String(error),
        tone: "danger",
      });
    } finally {
      setBusyPortal(false);
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

      <div className="orbit-billing__actions">
        <Button
          type="button"
          variant="primary"
          size="sm"
          icon={<ExternalLink size={14} />}
          onClick={() =>
            openExternalUrl(PRICING_URL).catch((error: unknown) =>
              pushToast({
                title: t("account.failed"),
                description: error instanceof Error ? error.message : String(error),
                tone: "danger",
              }),
            )
          }
          data-testid="billing-choose-plan-button"
        >
          {t("account.billing.choosePlan")}
        </Button>
        {billing.plan !== "free" && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={busyPortal}
            icon={<ExternalLink size={14} />}
            onClick={() => void openPortal()}
            data-testid="billing-portal-button"
          >
            {t("account.billing.manageBilling")}
          </Button>
        )}
      </div>
    </div>
  );
}
