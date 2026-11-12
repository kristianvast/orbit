import { FolderOpen, Github, Info } from "lucide-react";
import { BrandMark, Card } from "../../design";
import { useT } from "../../i18n";
import { useOrion } from "../../lib/orion";
import { openExternalUrl } from "./BillingSection";
import { More, SettingsTitle } from "./parts";

const REPO_URL = "https://github.com/kristianvast/orbit";

function defaultPlatformDataPath(): string {
  if (typeof navigator === "undefined") {
    return "~/Library/Application Support/Orbit";
  }
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("win")) return "%APPDATA%\\Orbit";
  if (ua.includes("linux")) return "~/.local/share/Orbit";
  return "~/Library/Application Support/Orbit";
}

export function AboutCard() {
  const t = useT();
  const { client, endpoint } = useOrion();
  const version = client?.server?.serverVersion ?? "0.1.2";

  return (
    <Card title={<SettingsTitle icon={Info}>{t("settings.about.title")}</SettingsTitle>}>
      <div className="settings-stack" data-testid="settings-license-card">
        <p className="settings-brand">
          <BrandMark size={20} />
          <strong>Orbit &amp; Orion</strong>
          <span className="settings-mono">{version}</span>
        </p>
        <p className="settings-muted">{t("settings.about.license")}</p>
        <a
          className="settings-link"
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            e.preventDefault();
            void openExternalUrl(REPO_URL);
          }}
          data-testid="settings-source-link"
        >
          <Github size={16} aria-hidden="true" />
          {t("settings.about.source")}
        </a>
        <div className="settings-row">
          <FolderOpen size={18} className="settings-row__icon" aria-hidden="true" />
          <span className="settings-row__text">{t("settings.about.ownData")}</span>
        </div>
        <More summary={t("settings.about.details")}>
          <dl className="settings-facts">
            <dt>{t("settings.data.folder")}</dt>
            <dd data-testid="settings-data-folder-path">{defaultPlatformDataPath()}</dd>
            <dt>{t("settings.data.dbFile")}</dt>
            <dd>orbit.sqlite</dd>
            <dt>{t("settings.data.endpoint")}</dt>
            <dd data-testid="settings-orion-endpoint">
              {endpoint?.url ?? "ws://127.0.0.1:7717/ws"}
            </dd>
            <dt>{t("settings.data.serverVersion")}</dt>
            <dd>{version}</dd>
          </dl>
          <p className="settings-mono">{t("settings.about.footer")}</p>
        </More>
      </div>
    </Card>
  );
}
