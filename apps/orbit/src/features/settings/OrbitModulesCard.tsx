import { Camera, Layers, Plug, Tag } from "lucide-react";
import { useState } from "react";
import { Card, useToast } from "../../design";
import { type MessageKey, useT } from "../../i18n";
import { MODULE_IDS, type ModuleId, type OrbitModule, useModules } from "../../lib/modules";
import { useFarmSpecies } from "../../lib/species";
import { SettingsTitle } from "./parts";

const MODULE_META: Record<
  ModuleId,
  {
    labelKey: MessageKey;
    icon: typeof Tag;
  }
> = {
  herd: {
    labelKey: "settings.modules.herd.label",
    icon: Tag,
  },
  devices: {
    labelKey: "settings.modules.devices.label",
    icon: Plug,
  },
  cameras: {
    labelKey: "settings.modules.cameras.label",
    icon: Camera,
  },
};

export function OrbitModulesCard() {
  const t = useT();
  const { pushToast } = useToast();
  const { modules, enableModule, disableModule } = useModules();
  const { species } = useFarmSpecies();
  const [busyId, setBusyId] = useState<ModuleId | null>(null);

  const byId = new Map<ModuleId, OrbitModule>(modules.map((m) => [m.id, m]));

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
      title={<SettingsTitle icon={Layers}>{t("settings.modules.title")}</SettingsTitle>}
    >
      <ul className="settings-rows" data-testid="settings-modules-list">
        {MODULE_IDS.map((id) => {
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
          const label = t(labelKey);

          return (
            <li key={id} className="settings-row" data-testid={`settings-module-row-${id}`}>
              <span className="settings-tile" data-on={enabled} aria-hidden="true">
                <Icon size={18} />
              </span>
              <span className="settings-row__text">
                <span className="settings-row__label">{label}</span>
                <span className="settings-row__hint" data-testid={`settings-module-status-${id}`}>
                  {enabled
                    ? (formatAddedBy(mod) ?? t("settings.modules.status.on"))
                    : t("settings.modules.status.off")}
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="settings-switch"
                checked={enabled}
                aria-checked={enabled}
                aria-label={label}
                disabled={busyId !== null}
                onChange={() => void handleToggle(id, enabled)}
                data-testid={`settings-module-toggle-${id}`}
              />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
