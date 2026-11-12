import type { FarmInvite, FarmRole } from "@orbit/protocol";
import { Check, Copy } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge, Button, Input, Select, type SelectOption, useToast } from "../../design";
import { useI18n } from "../../i18n";
import { formatCompactTokens, parseTokenLimitInput } from "./MemberRow";

const row = {
  display: "flex",
  gap: "var(--space-2)",
  flexWrap: "wrap",
  alignItems: "center",
} as const;

export interface InviteCreateInput {
  readonly email: string;
  readonly role: FarmRole;
  readonly useFarmPlan: boolean;
  readonly monthlyTokenLimit: number | null;
}

export interface MemberInvitesProps {
  readonly busy: boolean;
  readonly invites: readonly FarmInvite[];
  readonly roleOptions: SelectOption[];
  readonly onCreateInvite: (input: InviteCreateInput) => Promise<{ email: string; code: string }>;
  readonly onRevokeInvite: (inviteId: string) => void;
}

export function MemberInvites({
  busy,
  invites,
  roleOptions,
  onCreateInvite,
  onRevokeInvite,
}: MemberInvitesProps) {
  const { t, formatDate } = useI18n();
  const { pushToast } = useToast();
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<FarmRole>("worker");
  const [inviteUseFarmPlan, setInviteUseFarmPlan] = useState(false);
  const [inviteLimit, setInviteLimit] = useState("");
  const [created, setCreated] = useState<{ email: string; code: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const inviteOwner = inviteRole === "owner";
  const effectiveInvitePlan = inviteOwner ? true : inviteUseFarmPlan;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const monthlyTokenLimit = inviteOwner ? null : parseTokenLimitInput(inviteLimit);
    const nextCreated = await onCreateInvite({
      email: email.trim(),
      role: inviteRole,
      useFarmPlan: effectiveInvitePlan,
      monthlyTokenLimit,
    });
    setCreated(nextCreated);
    setCopied(false);
    setEmail("");
    setInviteUseFarmPlan(false);
    setInviteLimit("");
  };

  const copyCode = async () => {
    if (!created || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(created.code);
      setCopied(true);
      pushToast({ title: t("account.members.copied"), tone: "ok" });
    } catch (error) {
      pushToast({
        title: t("account.failed"),
        description: error instanceof Error ? error.message : String(error),
        tone: "danger",
      });
    }
  };

  return (
    <>
      <form
        className="settings-stack settings-divider"
        onSubmit={(e) => {
          void handleSubmit(e).catch(() => undefined);
        }}
        data-testid="invite-form"
      >
        <strong>{t("account.members.inviteTitle")}</strong>
        <div className="settings-invite-grid">
          <Input
            label={t("account.field.email")}
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="invite-email"
          />
          <Select
            label={t("account.members.role")}
            value={inviteRole}
            options={roleOptions}
            onChange={(e) => setInviteRole(e.target.value as FarmRole)}
            data-testid="invite-role"
          />
          <Input
            label={t("account.members.tokenLimit")}
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            placeholder={t("account.members.noLimit")}
            value={inviteOwner ? "" : inviteLimit}
            disabled={busy || inviteOwner}
            onChange={(e) => setInviteLimit(e.target.value)}
            data-testid="invite-token-limit"
          />
        </div>
        <div className="settings-invite-footer">
          <label className="settings-member__toggle">
            <input
              type="checkbox"
              role="switch"
              aria-checked={effectiveInvitePlan}
              aria-label={t("account.members.useFarmPlan")}
              className="settings-switch"
              checked={effectiveInvitePlan}
              disabled={busy || inviteOwner}
              onChange={(e) => setInviteUseFarmPlan(e.target.checked)}
              data-testid="invite-use-farm-plan"
            />
            <span>{t("account.members.useFarmPlan")}</span>
          </label>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={busy}
            data-testid="invite-submit"
          >
            {t("account.members.invite")}
          </Button>
        </div>
      </form>

      {created && (
        <div role="status" className="settings-invite-created" data-testid="invite-created">
          <strong>{t("account.members.codeTitle", { email: created.email })}</strong>
          <div style={row}>
            <code className="settings-invite-code" data-testid="invite-code">
              {created.code}
            </code>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={copied ? <Check size={14} /> : <Copy size={14} />}
              onClick={() => void copyCode()}
              data-testid="invite-code-copy"
            >
              {t("account.members.copyCode")}
            </Button>
          </div>
          <p className="settings-muted">{t("account.members.codeHint")}</p>
        </div>
      )}

      {invites.length > 0 && (
        <div className="settings-stack settings-divider">
          <strong>{t("account.members.pending")}</strong>
          <ul className="settings-rows" data-testid="invites-list">
            {invites.map((i) => {
              const planAllowed = i.role === "owner" || Boolean(i.useFarmPlan);
              return (
                <li key={i.id} className="settings-row" data-testid="invite-row">
                  <span className="settings-row__text">
                    <span className="settings-row__label">
                      {i.email} · {t(`account.role.${i.role}`)}
                    </span>
                    <span className="settings-row__hint">
                      {t("account.members.expires", {
                        date: formatDate(i.expiresAt, {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        }),
                      })}
                    </span>
                  </span>
                  <span style={row}>
                    {planAllowed && (
                      <Badge variant="accent" data-testid="invite-plan-badge">
                        {t("account.members.invitePlanAllowed")}
                      </Badge>
                    )}
                    {i.monthlyTokenLimit != null && (
                      <Badge
                        variant="neutral"
                        className="tabular-nums"
                        data-testid="invite-limit-badge"
                      >
                        {t("account.members.limitCap", {
                          limit: formatCompactTokens(i.monthlyTokenLimit),
                        })}
                      </Badge>
                    )}
                    <Button
                      variant="subtle"
                      size="sm"
                      disabled={busy}
                      onClick={() => onRevokeInvite(i.id)}
                      data-testid="invite-revoke"
                    >
                      {t("account.members.revoke")}
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}
