import { AudioLines } from "lucide-react";
import { Card } from "../../design";
import { useT } from "../../i18n";
import { type OrionVoiceChoice, useVoiceChoice } from "../voice";
import { SettingsTitle } from "./parts";

export function OrionVoiceCard() {
  const t = useT();
  const [choice, setChoice] = useVoiceChoice();

  return (
    <Card
      title={<SettingsTitle icon={AudioLines}>{t("voice.settings.title")}</SettingsTitle>}
      actions={
        <select
          className="orbit-input settings-inline-select"
          aria-label={t("voice.settings.label")}
          title={t("voice.settings.hint")}
          value={choice}
          onChange={(e) => setChoice(e.target.value === "female" ? "female" : "male")}
          data-testid="settings-voice-select"
        >
          {(["male", "female"] as const satisfies readonly OrionVoiceChoice[]).map((v) => (
            <option key={v} value={v}>
              {t(v === "male" ? "voice.settings.male" : "voice.settings.female")}
            </option>
          ))}
        </select>
      }
      className="settings-card--row"
    />
  );
}
