import type { AccessTool, Settings, SettingsUpdate } from "@orbit/protocol";
import { Globe, HeartHandshake, MousePointer2, Share2, ShieldCheck, Terminal } from "lucide-react";
import { useState } from "react";
import { Card, useToast } from "../../design";
import { type MessageKey, useT } from "../../i18n";
import { useOrion } from "../../lib/orion";
import { AccessPrompt } from "../access";
import { SettingsTitle, SwitchRow } from "./parts";

const ACCESS_SWITCHES: {
  tool: AccessTool;
  icon: typeof Terminal;
  labelKey: MessageKey;
  hintKey: MessageKey;
}[] = [
  {
    tool: "shell",
    icon: Terminal,
    labelKey: "settings.access.shell",
    hintKey: "settings.access.shellHint",
  },
  {
    tool: "browser",
    icon: Globe,
    labelKey: "settings.access.browser",
    hintKey: "settings.access.browserHint",
  },
  {
    tool: "computer",
    icon: MousePointer2,
    labelKey: "settings.access.computer",
    hintKey: "settings.access.computerHint",
  },
];

interface SettingsCardProps {
  readonly settings: Settings | null;
  readonly onSettings: (next: Settings) => void;
}

function useSettingsUpdate(onSettings: (next: Settings) => void, failedKey: MessageKey) {
  const t = useT();
  const { client } = useOrion();
  const { pushToast } = useToast();
  const [saving, setSaving] = useState(false);
  const update = async (patch: SettingsUpdate) => {
    if (!client) return;
    setSaving(true);
    try {
      onSettings(await client.request("settings.update", patch));
    } catch (err) {
      pushToast({
        title: t(failedKey),
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    } finally {
      setSaving(false);
    }
  };
  return { saving, update };
}

export function AccessCard({ settings, onSettings }: SettingsCardProps) {
  const t = useT();
  const { saving, update } = useSettingsUpdate(onSettings, "settings.access.saveFailed");
  // Turning a tool on for the first time asks the same question Orion asks before first using it.
  const [asking, setAsking] = useState<AccessTool | null>(null);
  const turn = (tool: AccessTool, allowed: boolean) => {
    if (allowed && !settings?.toolAccessAccepted?.[tool]) setAsking(tool);
    else void update({ toolAccess: { [tool]: allowed } });
  };
  const answer = async (allow: boolean) => {
    if (asking && allow) await update({ toolAccess: { [asking]: true } });
    setAsking(null);
  };
  return (
    <Card title={<SettingsTitle icon={ShieldCheck}>{t("settings.access.title")}</SettingsTitle>}>
      <div className="settings-rows">
        {ACCESS_SWITCHES.map(({ tool, icon, labelKey, hintKey }) => (
          <SwitchRow
            key={tool}
            icon={icon}
            label={t(labelKey)}
            hint={t(hintKey)}
            checked={settings?.toolAccess?.[tool] ?? false}
            disabled={!settings || saving}
            onChange={(allowed) => turn(tool, allowed)}
            testId={`settings-access-${tool}`}
          />
        ))}
      </div>
      {asking && (
        <AccessPrompt
          fromSettings
          tool={asking}
          busy={saving}
          onAnswer={(allow) => void answer(allow)}
        />
      )}
    </Card>
  );
}

export function PrivacyCard({ settings, onSettings }: SettingsCardProps) {
  const t = useT();
  const { saving, update } = useSettingsUpdate(onSettings, "settings.privacy.saveFailed");
  return (
    <Card
      title={<SettingsTitle icon={HeartHandshake}>{t("settings.privacy.title")}</SettingsTitle>}
    >
      <div className="settings-rows">
        <SwitchRow
          icon={Share2}
          label={t("settings.privacy.shareData")}
          hint={t("settings.privacy.shareDataHint")}
          checked={settings?.shareAnonymousData ?? true}
          disabled={!settings || saving}
          onChange={(shareAnonymousData) => void update({ shareAnonymousData })}
          testId="settings-share-anonymous-data"
        />
      </div>
    </Card>
  );
}
