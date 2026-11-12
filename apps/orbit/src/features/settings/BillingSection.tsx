import "./providers.css";
import type { AccountStatus, BillingPlans, BillingStatus, UsageSource } from "@orbit/protocol";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, useToast } from "../../design";
import { useI18n } from "../../i18n";
import { useOrion } from "../../lib/orion";
import { BillingSourceAndAllowances, UsageMeter } from "./BillingAllowances";
import {
  buildCheckoutParams,
  buildPortalParams,
  DEFAULT_FREE_BILLING,
  hasMultiUserBilling,
  openExternalUrl,
  PRICING_URL,
  resolveBillingAccount,
  resolveUsageChoice,
  statusBadgeMeta,
} from "./billing-model";

export {
  buildCheckoutParams,
  buildPortalParams,
  hasMultiUserBilling,
  openExternalUrl,
  PRICING_URL,
  resolveBillingAccount,
  resolveUsageChoice,
};

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
  const [busySource, setBusySource] = useState(false);

  useEffect(() => {
    if (!client || status.state !== "signed_in") {
      setCatalogue(null);
      setBilling(DEFAULT_FREE_BILLING);
      return;
    }
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
  const portalParams = buildPortalParams(status, billing);
  const canChoosePlan = resolveBillingAccount(status, billing) !== null;

  const selectSource = async (source: UsageSource) => {
    if (!client || resolveUsageChoice(billing) === source) return;
    setBusySource(true);
    try {
      setBilling(await client.request("billing.setSource", { source }));
    } catch (error) {
      pushToast({
        title: t("account.failed"),
        description: error instanceof Error ? error.message : String(error),
        tone: "danger",
      });
    } finally {
      setBusySource(false);
    }
  };

  const openPortal = async () => {
    if (!client || !portalParams) return;
    setBusyPortal(true);
    try {
      const res = await client.request("billing.portal", portalParams);
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

      <BillingSourceAndAllowances
        status={status}
        billing={billing}
        catalogue={catalogue}
        busySource={busySource}
        onSelectSource={(source) => void selectSource(source)}
      />

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
        {canChoosePlan && (
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
        )}
        {portalParams !== null && (
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
