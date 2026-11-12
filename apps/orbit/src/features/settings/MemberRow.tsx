import type { FarmMember, FarmRole } from "@orbit/protocol";
import { Check, Coins, LogOut, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, Select, type SelectOption } from "../../design";
import { useT } from "../../i18n";

export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 999_950) {
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function parseTokenLimitInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
}

export interface MemberUpdatePatch {
  readonly role?: FarmRole;
  readonly useFarmPlan?: boolean;
  readonly monthlyTokenLimit?: number | null;
}

export interface MemberRowProps {
  readonly member: FarmMember;
  readonly isSelf: boolean;
  readonly canManageTeam: boolean;
  readonly editable: boolean;
  readonly canLeave: boolean;
  readonly busy: boolean;
  readonly roleOptions: SelectOption[];
  readonly onUpdate: (patch: MemberUpdatePatch) => void;
  readonly onRequestRemove: () => void;
  readonly onRequestLeave: () => void;
}

export function MemberRow({
  member,
  isSelf,
  canManageTeam,
  editable,
  canLeave,
  busy,
  roleOptions,
  onUpdate,
  onRequestRemove,
  onRequestLeave,
}: MemberRowProps) {
  const t = useT();
  const isOwner = member.role === "owner";
  const currentLimit = member.monthlyTokenLimit ?? null;
  const [limitDraft, setLimitDraft] = useState(currentLimit === null ? "" : String(currentLimit));

  useEffect(() => {
    setLimitDraft(currentLimit === null ? "" : String(currentLimit));
  }, [currentLimit]);

  const parsedDraft = parseTokenLimitInput(limitDraft);
  const limitDirty = parsedDraft !== currentLimit;

  const commitLimit = () => {
    if (!limitDirty || isOwner || !editable || busy) return;
    onUpdate({ monthlyTokenLimit: parsedDraft });
  };

  const showSwitch = canManageTeam || member.useFarmPlan !== undefined || isOwner;
  const useFarmPlanChecked = isOwner ? true : Boolean(member.useFarmPlan);
  const switchDisabled = isOwner || !editable || busy;

  return (
    <li className="settings-member" data-testid="member-row">
      <div className="settings-member__main">
        <div className="settings-member__identity">
          <div className="settings-member__name-line">
            <strong>{member.name ?? member.email}</strong>
            {isSelf && <span className="settings-muted">({t("account.members.you")})</span>}
          </div>
          {member.name && <span className="settings-muted">{member.email}</span>}
          {member.usage && (
            <span
              className="settings-member__usage tabular-nums"
              title={t("account.members.usageTitle")}
              data-testid="member-usage"
            >
              <Coins size={13} aria-hidden="true" />
              {t("account.members.usage", {
                farm: formatCompactTokens(member.usage.farmTokens),
                own: formatCompactTokens(member.usage.ownTokens),
              })}
            </span>
          )}
        </div>

        <div className="settings-member__actions">
          {editable ? (
            <Select
              aria-label={t("account.members.role")}
              value={member.role}
              options={roleOptions}
              disabled={busy}
              onChange={(e) => onUpdate({ role: e.target.value as FarmRole })}
              data-testid="member-role"
            />
          ) : (
            <Badge variant="neutral">{t(`account.role.${member.role}`)}</Badge>
          )}

          {editable && (
            <Button
              variant="subtle"
              size="sm"
              disabled={busy}
              icon={<Trash2 size={15} />}
              onClick={onRequestRemove}
              data-testid="member-remove"
            >
              {t("account.members.remove")}
            </Button>
          )}

          {canLeave && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              icon={<LogOut size={14} />}
              onClick={onRequestLeave}
              data-testid="member-leave"
            >
              {t("account.members.leave")}
            </Button>
          )}
        </div>
      </div>

      {(showSwitch || (!isOwner && (editable || currentLimit !== null))) && (
        <div className="settings-member__controls">
          {showSwitch && (
            <label className="settings-member__toggle">
              <input
                type="checkbox"
                role="switch"
                aria-checked={useFarmPlanChecked}
                aria-label={t("account.members.useFarmPlan")}
                className="settings-switch"
                checked={useFarmPlanChecked}
                disabled={switchDisabled}
                onChange={(e) => onUpdate({ useFarmPlan: e.target.checked })}
                data-testid="member-use-farm-plan"
              />
              <span>{t("account.members.useFarmPlan")}</span>
            </label>
          )}

          {editable && !isOwner && (
            <div className="settings-member__limit">
              <input
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                className="orbit-input settings-member__limit-input tabular-nums"
                aria-label={t("account.members.tokenLimit")}
                placeholder={t("account.members.noLimit")}
                value={limitDraft}
                disabled={busy}
                onChange={(e) => setLimitDraft(e.target.value)}
                onBlur={commitLimit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitLimit();
                  }
                }}
                data-testid="member-token-limit"
              />
              {limitDirty && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  aria-label={t("account.members.saveLimit")}
                  title={t("account.members.saveLimit")}
                  icon={<Check size={14} />}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={commitLimit}
                  data-testid="member-token-limit-save"
                />
              )}
            </div>
          )}

          {!editable && !isOwner && currentLimit !== null && (
            <Badge variant="neutral" className="tabular-nums" data-testid="member-limit-badge">
              {t("account.members.limitCap", { limit: formatCompactTokens(currentLimit) })}
            </Badge>
          )}
        </div>
      )}
    </li>
  );
}
