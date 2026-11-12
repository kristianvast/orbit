import { Warehouse } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Button, Card, Input, useToast } from "../../design";
import { useT } from "../../i18n";
import { useOrion, useOrionQuery } from "../../lib/orion";
import { SettingsTitle } from "./parts";

function detectSystemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function FarmProfileCard() {
  const t = useT();
  const { client } = useOrion();
  const { pushToast } = useToast();
  const { data: summary, refetch } = useOrionQuery("farm.summary", undefined, {
    refetchTables: ["farms"],
  });

  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(() => detectSystemTimezone());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!summary?.farm) return;
    setName(summary.farm.name);
    if (summary.farm.timezone) {
      setTimezone(summary.farm.timezone);
    }
  }, [summary?.farm]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!client) return;
    setSaving(true);
    try {
      const trimmedName = name.trim();
      const trimmedTz = timezone.trim();
      if (trimmedName || trimmedTz) {
        await client.mutate("farm.update", {
          ...(trimmedName ? { name: trimmedName } : {}),
          ...(trimmedTz ? { timezone: trimmedTz } : {}),
        });
      }
      await refetch();
      pushToast({ title: t("settings.toast.farmSaved"), tone: "ok" });
    } catch (err) {
      pushToast({
        title: t("settings.toast.farmSaveFailed"),
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      id="farm-profile"
      data-testid="settings-farm-profile-card"
      title={<SettingsTitle icon={Warehouse}>{t("settings.farm.title")}</SettingsTitle>}
    >
      <form
        onSubmit={(e) => void handleSubmit(e)}
        style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
      >
        <div className="orbit-split-grid">
          <Input
            label={t("settings.farm.name")}
            placeholder={t("settings.farm.namePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="settings-farm-name-input"
          />
          <Input
            label={t("settings.farm.timezone")}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            data-testid="settings-farm-timezone-input"
          />
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button
            type="submit"
            variant="primary"
            loading={saving}
            data-testid="settings-farm-save-button"
          >
            {t("settings.farm.save")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
