import type { Settings } from "@orbit/protocol";
import { Info, Languages, type LucideIcon, Sparkles, Tractor, UserRound } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router";
import { Card, Select, useToast } from "../../design";
import { isLocale, LOCALE_NAMES, LOCALES, type MessageKey, useI18n } from "../../i18n";
import { useOrion, useOrionEvent } from "../../lib/orion";
import { AboutCard } from "./AboutCard";
import { AccessCard, PrivacyCard } from "./AccessCard";
import { AccountCard, AccountSection, BillingSection } from "./AccountCard";
import { FarmProfileCard } from "./FarmProfileCard";
import { FeedbackCard } from "./FeedbackCard";
import { ModelCard } from "./ModelCard";
import { OrbitModulesCard } from "./OrbitModulesCard";
import { OrionVoiceCard } from "./OrionVoiceCard";
import { ProvidersCard } from "./ProvidersCard";
import { SettingsTitle } from "./parts";
import { UndoCard } from "./UndoCard";
import { YourOrbitCard } from "./YourOrbitCard";
import "./settings.css";

export { AccountCard, AccountSection, BillingSection, FarmProfileCard, OrbitModulesCard };

interface SectionInfo {
  readonly id: string;
  readonly icon: LucideIcon;
  readonly labelKey: MessageKey;
}

const FARM: SectionInfo = { id: "settings-farm", icon: Tractor, labelKey: "settings.section.farm" };
const ACCOUNT: SectionInfo = {
  id: "settings-account",
  icon: UserRound,
  labelKey: "settings.section.account",
};
const ORION: SectionInfo = {
  id: "settings-orion",
  icon: Sparkles,
  labelKey: "settings.section.orion",
};
const ABOUT: SectionInfo = { id: "settings-about", icon: Info, labelKey: "settings.section.about" };
const SECTIONS = [FARM, ACCOUNT, ORION, ABOUT];

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
}

function Section({ info, children }: { info: SectionInfo; children: ReactNode }) {
  const { t } = useI18n();
  const { id, icon: Icon, labelKey } = info;
  return (
    <section id={id} className="settings-section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="settings-section__title">
        <Icon size={22} className="settings-accent" aria-hidden="true" />
        {t(labelKey)}
      </h2>
      {children}
    </section>
  );
}

function LanguageCard() {
  const { t, locale, setLocale } = useI18n();
  return (
    <Card title={<SettingsTitle icon={Languages}>{t("settings.language.title")}</SettingsTitle>}>
      <Select
        label={t("settings.language.label")}
        value={locale}
        onChange={(e) => {
          if (isLocale(e.target.value)) setLocale(e.target.value);
        }}
        options={LOCALES.map((code) => ({ value: code, label: LOCALE_NAMES[code] }))}
        data-testid="settings-language-select"
      />
    </Card>
  );
}

export default function SettingsPage() {
  const { client, state: connState } = useOrion();
  const { pushToast } = useToast();
  const { t } = useI18n();
  const location = useLocation();
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    const hash = location.hash.replace(/^#/, "");
    if (hash) scrollToId(hash);
  }, [location.hash]);

  const loadAll = useCallback(async (): Promise<Settings | null> => {
    if (!client) return null;
    try {
      const loaded = await client.request("settings.get");
      setSettings(loaded);
      return loaded;
    } catch (err) {
      pushToast({
        title: t("settings.toast.loadFailed"),
        description: err instanceof Error ? err.message : String(err),
        tone: "warn",
      });
      return null;
    }
  }, [client, pushToast, t]);

  useEffect(() => {
    if (connState === "open" || connState === "connecting") void loadAll();
  }, [connState, loadAll]);
  // Signing in or out switches the default model to or from the Orbit cloud model.
  useOrionEvent("account.updated", () => void loadAll());

  const handleProvidersChanged = async (connectedProviderId?: string) => {
    const loaded = await loadAll();
    const first = loaded?.availableModels.find((m) => m.provider === connectedProviderId);
    if (!client || !connectedProviderId || !first) return;
    try {
      setSettings(
        await client.request("settings.update", {
          provider: connectedProviderId,
          model: first.id,
        }),
      );
    } catch (err) {
      pushToast({
        title: t("settings.toast.modelSaveFailed"),
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    }
  };

  return (
    <div className="orbit-container settings-page" data-testid="settings-page">
      <header className="settings-header">
        <h1>{t("settings.title")}</h1>
        <nav className="settings-jump" aria-label={t("settings.section.nav")}>
          {SECTIONS.map(({ id, icon: Icon, labelKey }) => (
            <button key={id} type="button" onClick={() => scrollToId(id)}>
              <Icon size={15} className="settings-accent" aria-hidden="true" />
              {t(labelKey)}
            </button>
          ))}
        </nav>
      </header>

      <Section info={FARM}>
        <FarmProfileCard />
        <div className="orbit-split-grid">
          <OrbitModulesCard />
          <LanguageCard />
        </div>
      </Section>

      <Section info={ACCOUNT}>
        <AccountSection />
        <PrivacyCard settings={settings} onSettings={setSettings} />
      </Section>

      <Section info={ORION}>
        <div className="orbit-split-grid">
          <ModelCard settings={settings} onSettings={setSettings} />
          <OrionVoiceCard />
        </div>
        <ProvidersCard onChanged={(id) => void handleProvidersChanged(id)} />
        <div className="orbit-split-grid">
          <AccessCard settings={settings} onSettings={setSettings} />
          <UndoCard />
        </div>
      </Section>

      <Section info={ABOUT}>
        <div className="orbit-split-grid">
          <YourOrbitCard />
          <AboutCard />
        </div>
        <FeedbackCard />
      </Section>
    </div>
  );
}
