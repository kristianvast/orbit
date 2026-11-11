import { Camera, Clock, Layers, Radio, Tag } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, useToast } from "../../design";
import { type MessageKey, useI18n } from "../../i18n";
import { MODULE_IDS, type ModuleId, type OrbitModule, useModules } from "../../lib/modules";
import { useFarmSpecies } from "../../lib/species";

const MODULE_META: Record<
  ModuleId,
  {
    labelKey: MessageKey;
    descKey: MessageKey;
    icon: typeof Tag;
  }
> = {
  herd: {
    labelKey: "settings.modules.herd.label",
    descKey: "settings.modules.herd.description",
    icon: Tag,
  },
  devices: {
    labelKey: "settings.modules.devices.label",
    descKey: "settings.modules.devices.description",
    icon: Radio,
  },
  cameras: {
    labelKey: "settings.modules.cameras.label",
    descKey: "settings.modules.cameras.description",
    icon: Camera,
  },
};

const MODULE_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

export function OrbitModulesCard() {
  const { t, formatDate } = useI18n();
  const { pushToast } = useToast();
  const { modules, enableModule, disableModule } = useModules();
  const { species } = useFarmSpecies();
  const [busyId, setBusyId] = useState<ModuleId | null>(null);

  const byId = new Map<ModuleId, OrbitModule>(modules.map((m) => [m.id, m]));
  const activeCount = modules.filter((m) => m.enabled).length;

  const handleToggle = async (id: ModuleId, currentlyEnabled: boolean) => {
    setBusyId(id);
    try {
      if (currentlyEnabled) {
        await disableModule(id);
      } else {
        await enableModule(id);
      }
    } catch (err) {
      pushToast({
        title: t("settings.toast.moduleFailed"),
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    } finally {
      setBusyId(null);
    }
  };

  const formatAddedBy = (mod: OrbitModule | undefined): string | null => {
    if (!mod?.enabled) return null;
    switch (mod.enabledBy) {
      case "orion":
        return t("settings.modules.addedBy.orion");
      case "user":
        return t("settings.modules.addedBy.user");
      case "auto":
        return t("settings.modules.addedBy.auto");
      default:
        return t("settings.modules.status.on");
    }
  };

  return (
    <Card
      id="modules"
      data-testid="settings-modules-card"
      title={t("settings.modules.title")}
      subtitle={t("settings.modules.subtitle")}
      actions={
        <Badge
          variant={activeCount > 0 ? "ok" : "neutral"}
          icon={<Layers size={12} />}
          data-testid="settings-modules-badge"
        >
          {t("settings.modules.badge", { count: activeCount })}
        </Badge>
      }
    >
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
        }}
        data-testid="settings-modules-list"
      >
        {MODULE_IDS.map((id, idx) => {
          const meta = MODULE_META[id];
          const labelKey: MessageKey =
            id === "herd"
              ? species === "horse"
                ? "settings.modules.herd.label.horse"
                : "settings.modules.herd.label.cattle"
              : meta.labelKey;
          const Icon = meta.icon;
          const mod = byId.get(id);
          const enabled = mod?.enabled === true;
          const addedByLabel = formatAddedBy(mod);
          const addedAtLabel =
            enabled && mod?.enabledAt ? formatDate(mod.enabledAt, MODULE_TIME_FORMAT) : null;

          return (
            <li
              key={id}
              data-testid={`settings-module-row-${id}`}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: "var(--space-4)",
                paddingBlock: "var(--space-4)",
                borderBlockStart: idx === 0 ? "none" : "1px solid var(--border-subtle)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "var(--space-3)",
                  minInlineSize: 0,
                  flex: 1,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    inlineSize: "2.25rem",
                    blockSize: "2.25rem",
                    borderRadius: "var(--radius-md)",
                    backgroundColor: enabled
                      ? "var(--accent-primary-subtle)"
                      : "var(--bg-elevated)",
                    color: enabled ? "var(--accent-primary)" : "var(--text-secondary)",
                    flexShrink: 0,
                  }}
                >
                  <Icon size={18} />
                </span>

                <div style={{ minInlineSize: 0, flex: 1 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: "var(--space-2)",
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: "var(--text-base)",
                        color: "var(--text-primary)",
                      }}
                    >
                      {t(labelKey)}
                    </span>
                    <Badge
                      variant={enabled ? "ok" : "neutral"}
                      data-testid={`settings-module-status-${id}`}
                    >
                      {enabled
                        ? (addedByLabel ?? t("settings.modules.status.on"))
                        : t("settings.modules.status.off")}
                    </Badge>
                  </div>

                  <p
                    style={{
                      margin: "var(--space-1) 0 0 0",
                      fontSize: "var(--text-sm)",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {t(meta.descKey)}
                  </p>

                  {enabled && (addedByLabel || addedAtLabel) && (
                    <div
                      className="tabular-nums"
                      data-testid={`settings-module-meta-${id}`}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "var(--space-1)",
                        marginBlockStart: "var(--space-1)",
                        fontSize: "var(--text-xs)",
                        color: "var(--text-muted)",
                      }}
                    >
                      <Clock size={11} aria-hidden="true" />
                      <span>
                        {addedByLabel}
                        {addedAtLabel ? t("settings.modules.addedAt", { time: addedAtLabel }) : ""}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <Button
                variant={enabled ? "secondary" : "primary"}
                size="sm"
                role="switch"
                aria-checked={enabled}
                aria-label={`${t(labelKey)}: ${
                  enabled ? t("settings.modules.disable") : t("settings.modules.enable")
                }`}
                loading={busyId === id}
                disabled={busyId !== null && busyId !== id}
                onClick={() => void handleToggle(id, enabled)}
                data-testid={`settings-module-toggle-${id}`}
              >
                {enabled ? t("settings.modules.disable") : t("settings.modules.enable")}
              </Button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
