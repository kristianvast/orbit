import type { AccountStatus } from "@orbit/protocol";
import { Check, ChevronDown, Cloud, HardDrive, Loader2 } from "lucide-react";
import { useState } from "react";
import { Badge, Button, useToast } from "../../design";
import { type TranslateFn, useT } from "../../i18n";
import { buildFarmPickerEntries, type FarmPickerEntry, useAccount } from "../../lib/account";
import { useOrion } from "../../lib/orion";

function entryDisplayName(entry: FarmPickerEntry, t: TranslateFn): string {
  const trimmed = entry.name?.trim();
  if (trimmed) return trimmed;
  return entry.kind === "local" ? t("account.farms.localFallback") : t("shell.farm.fallbackName");
}

export interface FarmPickerListProps {
  readonly status?: AccountStatus | null;
}

export function FarmPickerList({ status: statusProp }: FarmPickerListProps = {}) {
  const t = useT();
  const { client } = useOrion();
  const { pushToast } = useToast();
  const account = useAccount();
  const [localOpening, setLocalOpening] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const effectiveStatus = statusProp !== undefined ? statusProp : account.status;
  const entries = buildFarmPickerEntries(effectiveStatus);
  const openingName = account.openingFarmName ?? localOpening;

  if (entries.length === 0 && !openingName) return null;

  const handleSelect = async (entry: FarmPickerEntry) => {
    if (entry.isOpen || !client) return;
    const label = entryDisplayName(entry, t);
    setBusyId(entry.id);
    try {
      const res =
        statusProp !== undefined
          ? await client.request("farms.open", { farmId: entry.id })
          : await account.openFarm(entry.id, label);
      if (statusProp !== undefined && res.restarting) {
        setLocalOpening(label);
      }
    } catch (err) {
      setLocalOpening(null);
      pushToast({
        title: t("account.failed"),
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="settings-farm-picker" data-testid="farm-picker-section">
      {openingName && (
        <div className="settings-farm-opening" role="status" data-testid="farm-picker-opening">
          <Loader2 size={15} className="orbit-spin settings-accent" aria-hidden="true" />
          <span>{t("account.farms.opening", { name: openingName })}</span>
        </div>
      )}
      {entries.length > 0 && (
        <ul
          className="settings-rows"
          aria-label={t("account.farms.label")}
          data-testid="farm-picker"
        >
          {entries.map((entry) => {
            const label = entryDisplayName(entry, t);
            const hint =
              entry.kind === "cloud" && entry.role
                ? t(`account.role.${entry.role}`)
                : t("account.badge.local");
            return (
              <li
                key={entry.id}
                className="settings-row"
                data-testid={`farm-picker-item-${entry.id}`}
                data-open={entry.isOpen ? "true" : "false"}
              >
                <span className="settings-tile" data-on={entry.isOpen} aria-hidden="true">
                  {entry.kind === "local" ? <HardDrive size={17} /> : <Cloud size={17} />}
                </span>
                <span className="settings-row__text">
                  <span className="settings-row__label">{label}</span>
                  <span className="settings-row__hint">{hint}</span>
                </span>
                {entry.isOpen ? (
                  <Badge
                    variant="ok"
                    icon={<Check size={12} />}
                    data-testid={`farm-picker-open-${entry.id}`}
                  >
                    {t("account.farms.openBadge")}
                  </Badge>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={busyId === entry.id}
                    disabled={busyId !== null || openingName !== null}
                    onClick={() => void handleSelect(entry)}
                    data-testid={`farm-picker-switch-${entry.id}`}
                  >
                    {t("account.farms.switch")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function CompactFarmPicker({ fallbackName }: { readonly fallbackName: string }) {
  const t = useT();
  const { pushToast } = useToast();
  const { status, openingFarmName, openFarm } = useAccount();
  const [busy, setBusy] = useState(false);

  const entries = buildFarmPickerEntries(status);
  const openEntry = entries.find((e) => e.isOpen);

  if (openingFarmName) {
    return (
      <span className="orbit-topbar__opening" role="status" data-testid="shell-farm-opening">
        <Loader2 size={14} className="orbit-spin" aria-hidden="true" />
        <span>{t("account.farms.opening", { name: openingFarmName })}</span>
      </span>
    );
  }

  const showDropdown = entries.length > 1 || (entries.length === 1 && !openEntry);
  if (!showDropdown) {
    const label = openEntry ? entryDisplayName(openEntry, t) : fallbackName;
    return <span className="orbit-topbar__name">{label}</span>;
  }

  const handleChange = async (nextId: string) => {
    const target = entries.find((e) => e.id === nextId);
    if (!target || target.isOpen) return;
    setBusy(true);
    try {
      await openFarm(target.id, entryDisplayName(target, t));
    } catch (err) {
      pushToast({
        title: t("account.failed"),
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="orbit-topbar__picker-wrap">
      <select
        className="orbit-topbar__picker"
        aria-label={t("account.farms.switchLabel")}
        value={openEntry?.id ?? ""}
        disabled={busy}
        onChange={(e) => void handleChange(e.target.value)}
        data-testid="shell-farm-picker"
      >
        {!openEntry && (
          <option value="" disabled>
            {fallbackName}
          </option>
        )}
        {entries.map((entry) => {
          const base = entryDisplayName(entry, t);
          const optionLabel =
            entry.kind === "local"
              ? t("account.farms.localOption", { name: base })
              : entry.role
                ? `${base} · ${t(`account.role.${entry.role}`)}`
                : base;
          return (
            <option key={entry.id} value={entry.id}>
              {optionLabel}
            </option>
          );
        })}
      </select>
      <ChevronDown size={14} className="orbit-topbar__picker-icon" aria-hidden="true" />
    </div>
  );
}
