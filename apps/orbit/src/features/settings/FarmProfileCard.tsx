import type { Species } from "@orbit/schema";
import { type FormEvent, useEffect, useState } from "react";
import { Badge, Button, Card, Input, useToast } from "../../design";
import { useT } from "../../i18n";
import { useOrion, useOrionQuery } from "../../lib/orion";
import { useFarmSpecies } from "../../lib/species";

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
  const { species, setSpecies } = useFarmSpecies();
  const { data: summary, refetch } = useOrionQuery("farm.summary", undefined, {
    refetchTables: ["farms"],
  });

  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(() => detectSystemTimezone());
  const [selectedSpecies, setSelectedSpecies] = useState<Species>(species);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSelectedSpecies(species);
  }, [species]);

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
      await setSpecies(selectedSpecies);
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
      title={t("settings.farm.title")}
      subtitle={t("settings.farm.subtitle")}
      actions={
        <Badge variant="neutral">
          {t(
            selectedSpecies === "horse"
              ? "settings.farm.species.horse"
              : "settings.farm.species.cattle",
          )}
        </Badge>
      }
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

        <div className="orbit-field">
          <span className="orbit-label">{t("settings.farm.species")}</span>
          <div
            className="orbit-tablist"
            role="tablist"
            aria-label={t("settings.farm.species")}
            style={{ alignSelf: "flex-start" }}
          >
            {(["cattle", "horse"] as const).map((option) => {
              const active = selectedSpecies === option;
              return (
                <button
                  key={option}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className="orbit-tab"
                  data-testid={`settings-farm-species-${option}`}
                  onClick={() => setSelectedSpecies(option)}
                >
                  {t(
                    option === "horse"
                      ? "settings.farm.species.horse"
                      : "settings.farm.species.cattle",
                  )}
                </button>
              );
            })}
          </div>
          <p className="orbit-field__hint">{t("settings.farm.speciesHint")}</p>
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
