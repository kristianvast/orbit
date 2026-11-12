import { AudioLines } from "lucide-react";
import { Card, Select } from "../../design";
import { useT } from "../../i18n";
import { type OrionVoiceChoice, useVoiceChoice } from "../voice";
import { SettingsTitle } from "./parts";

export function OrionVoiceCard() {
  const t = useT();
  const [choice, setChoice] = useVoiceChoice();

  return (
    <Card title={<SettingsTitle icon={AudioLines}>{t("voice.settings.title")}</SettingsTitle>}>
      <Select
        label={t("voice.settings.label")}
        value={choice}
        onChange={(e) => setChoice(e.target.value === "female" ? "female" : "male")}
        options={(["male", "female"] as const satisfies readonly OrionVoiceChoice[]).map((v) => ({
          value: v,
          label: t(v === "male" ? "voice.settings.male" : "voice.settings.female"),
        }))}
        hint={t("voice.settings.hint")}
        data-testid="settings-voice-select"
      />
    </Card>
  );
}
