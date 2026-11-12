import type { Settings, ThinkingLevel } from "@orbit/protocol";
import { Brain, Cpu } from "lucide-react";
import { useMemo, useState } from "react";
import { Card, Select, Skeleton, useToast } from "../../design";
import { type MessageKey, useT } from "../../i18n";
import { useOrion } from "../../lib/orion";
import { More, SettingsTitle } from "./parts";

const THINKING_OPTIONS: { value: ThinkingLevel; labelKey: MessageKey }[] = [
  { value: "off", labelKey: "settings.thinking.off" },
  { value: "minimal", labelKey: "settings.thinking.minimal" },
  { value: "low", labelKey: "settings.thinking.low" },
  { value: "medium", labelKey: "settings.thinking.medium" },
  { value: "high", labelKey: "settings.thinking.high" },
  { value: "xhigh", labelKey: "settings.thinking.xhigh" },
];

const COMMON_PROVIDERS = ["orbit-gateway", "anthropic", "openai", "google"];

type ModelUpdate = {
  provider?: string | null;
  model?: string | null;
  thinkingLevel?: ThinkingLevel;
};

export function ModelCard({
  settings,
  onSettings,
}: {
  settings: Settings | null;
  onSettings: (next: Settings) => void;
}) {
  const t = useT();
  const { client } = useOrion();
  const { pushToast } = useToast();
  const [saving, setSaving] = useState(false);

  const provider = settings?.provider ?? settings?.availableModels[0]?.provider ?? "orbit-gateway";
  const model =
    settings?.model ??
    settings?.availableModels.find((m) => m.provider === provider)?.id ??
    settings?.availableModels[0]?.id ??
    "";

  const providers = useMemo(() => {
    const set = new Set<string>();
    for (const m of settings?.availableModels ?? []) set.add(m.provider);
    if (settings?.provider) set.add(settings.provider);
    for (const p of Object.keys(settings?.apiKeys ?? {})) set.add(p);
    if (set.size === 0) for (const p of COMMON_PROVIDERS) set.add(p);
    return [...set];
  }, [settings]);

  const models = (settings?.availableModels ?? []).filter((m) => m.provider === provider);
  const modelName = models.find((m) => m.id === model)?.name ?? model;

  const providerLabel = (p: string) =>
    p === "orion-mock"
      ? t("settings.model.providerMock")
      : p === "orbit-gateway"
        ? t("settings.model.providerGateway")
        : p;

  const save = async (update: ModelUpdate) => {
    if (!client) return;
    setSaving(true);
    try {
      const updated = await client.request("settings.update", update);
      onSettings(updated);
      pushToast({
        title: t("settings.toast.modelSaved"),
        description:
          updated.provider && updated.model
            ? t("settings.toast.modelSavedDesc", { model: `${updated.provider}/${updated.model}` })
            : t("settings.toast.modelSavedDefault"),
        tone: "ok",
      });
    } catch (err) {
      pushToast({
        title: t("settings.toast.modelSaveFailed"),
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    } finally {
      setSaving(false);
    }
  };

  const changeProvider = (next: string) => {
    const first = (settings?.availableModels ?? []).find((m) => m.provider === next);
    void save({ provider: next || null, model: first?.id ?? null });
  };

  const thinkingKey =
    THINKING_OPTIONS.find((o) => o.value === settings?.thinkingLevel)?.labelKey ??
    "settings.thinking.medium";

  return (
    <Card title={<SettingsTitle icon={Cpu}>{t("settings.model.title")}</SettingsTitle>}>
      {!settings ? (
        <Skeleton height="2.75rem" />
      ) : (
        <div className="settings-stack">
          <ul className="settings-rows">
            <li className="settings-row">
              <Cpu size={18} className="settings-row__icon" aria-hidden="true" />
              <span className="settings-row__text">
                <span className="settings-row__label" data-testid="settings-model-current">
                  {modelName || t("settings.model.default")}
                </span>
                <span className="settings-row__hint">{providerLabel(provider)}</span>
              </span>
            </li>
            <li className="settings-row">
              <Brain size={18} className="settings-row__icon" aria-hidden="true" />
              <span className="settings-row__text">
                <span className="settings-row__label">{t(thinkingKey)}</span>
                <span className="settings-row__hint">{t("settings.model.thinking")}</span>
              </span>
            </li>
          </ul>
          <More summary={t("settings.model.change")} testId="settings-model-change">
            <Select
              label={t("settings.model.provider")}
              value={provider}
              disabled={saving}
              onChange={(e) => changeProvider(e.target.value)}
              options={providers.map((p) => ({ value: p, label: providerLabel(p) }))}
              data-testid="settings-provider-select"
            />
            <Select
              label={t("settings.model.model")}
              value={model}
              disabled={saving || models.length === 0}
              onChange={(e) => void save({ provider, model: e.target.value || null })}
              options={
                models.length > 0
                  ? models.map((m) => ({ value: m.id, label: m.name }))
                  : [{ value: model, label: model || t("settings.model.noModels") }]
              }
              data-testid="settings-model-select"
            />
            <Select
              label={t("settings.model.thinking")}
              value={settings.thinkingLevel}
              disabled={saving}
              onChange={(e) => void save({ thinkingLevel: e.target.value as ThinkingLevel })}
              options={THINKING_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
              data-testid="settings-thinking-select"
            />
          </More>
        </div>
      )}
    </Card>
  );
}
