import type {
  AccountAllowance,
  AccountStatus,
  BillingPlans,
  BillingStatus,
  UsageSource,
} from "@orbit/protocol";
import { UserRound, Warehouse } from "lucide-react";
import { Badge } from "../../design";
import { useI18n } from "../../i18n";
import { hasMultiUserBilling, resolveUsageChoice } from "./billing-model";

export function UsageMeter({
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

function AllowanceItem({
  kind,
  allowance,
  catalogue,
  active,
  testId,
}: {
  readonly kind: "farm" | "personal";
  readonly allowance: AccountAllowance;
  readonly catalogue: BillingPlans | null;
  readonly active: boolean;
  readonly testId: string;
}) {
  const { t, formatNumber, formatDate } = useI18n();
  const Icon = kind === "farm" ? Warehouse : UserRound;
  const planName = catalogue?.plans.find((p) => p.id === allowance.plan)?.name ?? allowance.plan;

  return (
    <div
      className="orbit-billing__allowance"
      data-active={active ? "true" : "false"}
      data-testid={testId}
    >
      <div className="orbit-billing__allowance-head">
        <span className="orbit-billing__allowance-title">
          <Icon size={15} className="settings-accent" aria-hidden="true" />
          <strong>
            {t(
              kind === "farm"
                ? "account.billing.allowance.farm"
                : "account.billing.allowance.personal",
            )}
          </strong>
        </span>
        <Badge variant={active ? "accent" : "neutral"}>{planName}</Badge>
      </div>
      <span className="orbit-billing__meter-val tabular-nums" data-testid={`${testId}-tokens`}>
        {t("account.billing.tokensUsage", {
          used: formatNumber(allowance.tokensUsed),
          allowance: formatNumber(allowance.tokenAllowance),
        })}
      </span>
      {allowance.trialEndsAt && (
        <span className="settings-muted tabular-nums" data-testid={`${testId}-trial`}>
          {t("account.billing.allowance.trialEnds", {
            date: formatDate(allowance.trialEndsAt, {
              year: "numeric",
              month: "short",
              day: "numeric",
            }),
          })}
        </span>
      )}
    </div>
  );
}

export interface BillingSourceAndAllowancesProps {
  readonly status: AccountStatus;
  readonly billing: BillingStatus;
  readonly catalogue: BillingPlans | null;
  readonly busySource: boolean;
  readonly onSelectSource: (source: UsageSource) => void;
}

export function BillingSourceAndAllowances({
  status,
  billing,
  catalogue,
  busySource,
  onSelectSource,
}: BillingSourceAndAllowancesProps) {
  const { t, formatNumber } = useI18n();

  if (!hasMultiUserBilling(billing)) return null;

  const hasFarmContext = status.farm !== null || billing.farm != null;
  const selectedSource = resolveUsageChoice(billing);
  const farmDisabled = billing.farmPlanAllowed === false;

  return (
    <div className="orbit-billing__multi" data-testid="billing-multi-user">
      {hasFarmContext && (
        <div className="orbit-billing__source">
          <div
            role="tablist"
            aria-label={t("account.billing.source.label")}
            className="orbit-tablist"
            data-testid="billing-source-switch"
          >
            <button
              type="button"
              role="tab"
              aria-selected={selectedSource === "farm"}
              disabled={busySource || farmDisabled}
              className="orbit-tab orbit-billing__source-tab"
              onClick={() => onSelectSource("farm")}
              data-testid="billing-source-farm"
            >
              <Warehouse size={14} aria-hidden="true" />
              {t("account.billing.source.farm")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={selectedSource === "own"}
              disabled={busySource}
              className="orbit-tab orbit-billing__source-tab"
              onClick={() => onSelectSource("own")}
              data-testid="billing-source-own"
            >
              <UserRound size={14} aria-hidden="true" />
              {t("account.billing.source.own")}
            </button>
          </div>

          {farmDisabled && (
            <p className="settings-muted" data-testid="billing-farm-disallowed-hint">
              {t("account.billing.source.disallowedHint")}
            </p>
          )}
        </div>
      )}

      {(billing.farm != null || (hasFarmContext && billing.personal != null)) && (
        <div className="orbit-billing__allowances" data-testid="billing-allowances">
          {billing.farm && (
            <AllowanceItem
              kind="farm"
              allowance={billing.farm}
              catalogue={catalogue}
              active={selectedSource === "farm" && !farmDisabled}
              testId="billing-allowance-farm"
            />
          )}
          {billing.personal && (
            <AllowanceItem
              kind="personal"
              allowance={billing.personal}
              catalogue={catalogue}
              active={selectedSource === "own" || farmDisabled}
              testId="billing-allowance-personal"
            />
          )}
        </div>
      )}

      {billing.member && (
        <p className="settings-muted tabular-nums" data-testid="billing-member-usage">
          {billing.member.tokenLimit !== null
            ? t("account.billing.member.withLimit", {
                used: formatNumber(billing.member.tokensUsed),
                limit: formatNumber(billing.member.tokenLimit),
              })
            : t("account.billing.member.noLimit", {
                used: formatNumber(billing.member.tokensUsed),
              })}
        </p>
      )}
    </div>
  );
}
