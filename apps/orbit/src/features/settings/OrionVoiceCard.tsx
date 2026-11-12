import { AudioLines } from "lucide-react";
import { Card, Select } from "../../design";
import { useT } from "../../i18n";
import { type OrionVoiceChoice, useVoiceChoice } from "../voice";

export function OrionVoiceCard() {
  const t = useT();
  const [choice, setChoice] = useVoiceChoice();

  return (
    <Card title={t("voice.settings.title")} actions={<AudioLines size={16} aria-hidden="true" />}>
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
