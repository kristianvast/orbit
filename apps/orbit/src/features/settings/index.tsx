import type { Settings } from "@orbit/protocol";
import { Info, Languages, type LucideIcon, Sparkles, Tractor, UserRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { Card, Select, useToast } from "../../design";
import { isLocale, LOCALE_NAMES, LOCALES, type MessageKey, useI18n } from "../../i18n";
import { useOrion, useOrionEvent } from "../../lib/orion";
import { AboutCard } from "./AboutCard";
import { AccessCard, PrivacyCard } from "./AccessCard";
import {
  AccountCard,
  AccountSection,
  BillingSection,
  FarmPickerList,
  FarmTeamSection,
  MembersCard,
} from "./AccountCard";
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

export {
  AccountCard,
  AccountSection,
  BillingSection,
  FarmPickerList,
  FarmProfileCard,
  MembersCard,
  OrbitModulesCard,
};

type PageId = "farm" | "account" | "orion" | "about";

const PAGES: { id: PageId; icon: LucideIcon; labelKey: MessageKey }[] = [
  { id: "farm", icon: Tractor, labelKey: "settings.section.farm" },
  { id: "account", icon: UserRound, labelKey: "settings.section.account" },
  { id: "orion", icon: Sparkles, labelKey: "settings.section.orion" },
  { id: "about", icon: Info, labelKey: "settings.section.about" },
];

// Older links point at a card by its id, such as /settings#providers; they open that card's page.
const PAGE_FOR_HASH: Record<string, PageId> = {
  "farm-profile": "farm",
  modules: "farm",
  account: "account",
  providers: "orion",
  undo: "orion",
  feedback: "about",
};

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
}

function pageFromLocation(pathname: string, hash: string): PageId {
  const sub = pathname.split("/settings/")[1]?.split("/")[0];
  const fromPath = PAGES.find((page) => page.id === sub)?.id;
  return fromPath ?? PAGE_FOR_HASH[hash.replace(/^#/, "")] ?? "farm";
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

  const page = pageFromLocation(location.pathname, location.hash);

  return (
    <div className="orbit-container settings-page" data-testid="settings-page">
      <header className="settings-header">
        <h1>{t("settings.title")}</h1>
        <nav className="settings-tabs" aria-label={t("settings.section.nav")}>
          {PAGES.map(({ id, icon: Icon, labelKey }) => (
            <Link
              key={id}
              to={`/settings/${id}`}
              className="settings-tab"
              aria-current={page === id ? "page" : undefined}
              data-testid={`settings-tab-${id}`}
            >
              <Icon size={16} aria-hidden="true" />
              {t(labelKey)}
            </Link>
          ))}
        </nav>
      </header>

      <div className="settings-stack" data-testid={`settings-page-${page}`}>
        {page === "farm" && (
          <>
            <FarmProfileCard />
            <div className="orbit-split-grid">
              <OrbitModulesCard />
              <LanguageCard />
            </div>
          </>
        )}

        {page === "account" && (
          <>
            <div className="settings-columns">
              <div className="settings-stack">
                <AccountSection />
              </div>
              <div className="settings-stack">
                <FarmTeamSection />
                <PrivacyCard settings={settings} onSettings={setSettings} />
              </div>
            </div>
          </>
        )}

        {page === "orion" && (
          <div className="settings-columns">
            <div className="settings-stack">
              <ModelCard settings={settings} onSettings={setSettings} />
              <ProvidersCard onChanged={(id) => void handleProvidersChanged(id)} />
              <OrionVoiceCard />
            </div>
            <div className="settings-stack">
              <AccessCard settings={settings} onSettings={setSettings} />
              <UndoCard />
            </div>
          </div>
        )}

        {page === "about" && (
          <div className="settings-columns">
            <div className="settings-stack">
              <AboutCard />
            </div>
            <div className="settings-stack">
              <YourOrbitCard />
              <FeedbackCard />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
