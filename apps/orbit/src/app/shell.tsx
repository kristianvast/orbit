import {
  Camera,
  CloudOff,
  Home,
  MessageSquare,
  MessageSquareHeart,
  Moon,
  Radio,
  Settings as SettingsIcon,
  Sun,
  Tag,
} from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router";
import { Badge, BrandMark, Button } from "../design";
import { CUSTOM_PAGE_ICON, useCustomPages } from "../features/pages";
import { type MessageKey, useT } from "../i18n";
import { useLocalUiLifecycle, useLocalUiReady } from "../lib/local-ui";
import { MODULE_IDS, type ModuleId, useModules } from "../lib/modules";
import { OrionConnectionBanner, resolveSyncNotice, useOrion, useOrionQuery } from "../lib/orion";
import { useFarmSpecies } from "../lib/species";
import { useAppUpdate } from "../lib/updater";
import { useTheme } from "./providers";

export interface NavItem {
  to: string;
  labelKey: MessageKey;
  end?: boolean;
  icon: typeof Home;
  moduleId?: ModuleId;
}

export const MODULE_NAV_ITEMS: Record<ModuleId, NavItem> = {
  herd: { to: "/herd", labelKey: "shell.nav.herd", icon: Tag, moduleId: "herd" },
  devices: { to: "/devices", labelKey: "shell.nav.devices", icon: Radio, moduleId: "devices" },
  cameras: { to: "/cameras", labelKey: "shell.nav.cameras", icon: Camera, moduleId: "cameras" },
};

export const SETTINGS_NAV_ITEM: NavItem = {
  to: "/settings",
  labelKey: "shell.nav.settings",
  icon: SettingsIcon,
};

export const HOME_NAV_ITEM: NavItem = {
  to: "/",
  labelKey: "shell.nav.home",
  end: true,
  icon: Home,
};

export const CHAT_NAV_ITEM: NavItem = {
  to: "/chat",
  labelKey: "shell.nav.chat",
  icon: MessageSquare,
};

export const NAV_ITEMS: NavItem[] = [
  HOME_NAV_ITEM,
  CHAT_NAV_ITEM,
  MODULE_NAV_ITEMS.herd,
  MODULE_NAV_ITEMS.devices,
  MODULE_NAV_ITEMS.cameras,
  SETTINGS_NAV_ITEM,
];

function SyncStatusBadge() {
  const { state: connState, syncStatus } = useOrion();
  const t = useT();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (syncStatus.unhealthySinceMs == null && syncStatus.state !== "offline") return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [syncStatus.unhealthySinceMs, syncStatus.state]);

  const notice = resolveSyncNotice(connState, syncStatus, nowMs);
  if (!notice) return null;

  if (notice === "local_waiting") {
    return (
      <Badge variant="warn" icon={<CloudOff size={13} />} data-testid="shell-sync-notice">
        {t("shell.sync.localWaiting")}
      </Badge>
    );
  }

  if (notice === "sync_error") {
    return (
      <Badge variant="danger" icon={<CloudOff size={13} />} data-testid="shell-sync-notice">
        {t("shell.sync.error")}
      </Badge>
    );
  }

  return (
    <Badge variant="warn" icon={<CloudOff size={13} />} data-testid="shell-sync-notice">
      {t("shell.sync.outOfSync")}
    </Badge>
  );
}

export function AppShell() {
  const { state: connState } = useOrion();
  const { data: summary } = useOrionQuery("farm.summary");
  const { isEnabled } = useModules();
  const { theme, toggleTheme } = useTheme();
  const { species } = useFarmSpecies();
  const customPages = useCustomPages();
  const t = useT();
  useLocalUiLifecycle();
  const localUiReady = useLocalUiReady();
  const appUpdate = useAppUpdate();

  const farmName = summary?.farm?.name ?? t("shell.farm.fallbackName");
  const alertCount = summary?.recentAlerts?.length ?? 0;
  const cattleCount = summary?.counts?.cattle ?? 0;
  const horseCount = summary?.counts?.horses ?? 0;
  const primaryAnimals =
    species === "horse"
      ? horseCount > 0
        ? horseCount
        : cattleCount
      : cattleCount > 0
        ? cattleCount
        : horseCount;
  const orionOnline = connState === "open";

  const topAndModuleNavItems: NavItem[] = [
    HOME_NAV_ITEM,
    CHAT_NAV_ITEM,
    ...MODULE_IDS.filter((id) => isEnabled(id)).map((id) => MODULE_NAV_ITEMS[id]),
  ];

  const renderNavItem = (item: NavItem) => {
    const Icon = item.icon;
    const labelKey: MessageKey =
      item.moduleId === "herd"
        ? species === "horse"
          ? "shell.nav.herd.horse"
          : "shell.nav.herd.cattle"
        : item.labelKey;
    const count =
      item.to === "/" && alertCount > 0
        ? alertCount
        : item.to === "/herd" && primaryAnimals > 0
          ? primaryAnimals
          : null;
    const testId = item.moduleId
      ? `nav-module-${item.moduleId}`
      : item.to === "/"
        ? "nav-home"
        : item.to === "/chat"
          ? "nav-chat"
          : "nav-settings";
    return (
      <li key={item.to}>
        <NavLink to={item.to} end={item.end} className="orbit-nav-link" data-testid={testId}>
          <span className="orbit-nav-link-inner">
            <Icon size={18} aria-hidden="true" />
            <span>{t(labelKey)}</span>
          </span>
          {count !== null && (
            <span
              className={
                item.to === "/" ? "orbit-nav-count orbit-nav-count--alert" : "orbit-nav-count"
              }
            >
              {count}
              {item.to === "/" && (
                <span className="orbit-visually-hidden">{t("shell.nav.alerts")}</span>
              )}
            </span>
          )}
        </NavLink>
      </li>
    );
  };

  return (
    <div className="orbit-shell">
      <aside className="orbit-rail" aria-label={t("shell.nav.primary")}>
        <div className="orbit-rail__top">
          <div className="orbit-brand">
            <BrandMark />
            <span className="orbit-brand__name">Orbit</span>
          </div>

          <nav aria-label={t("shell.nav.main")}>
            <ul className="orbit-nav-list">
              {topAndModuleNavItems.map(renderNavItem)}
              {customPages.length > 0 && (
                <li className="orbit-nav-section" aria-hidden="true">
                  {t("shell.nav.yourPages")}
                </li>
              )}
              {customPages.map((page) => (
                <li key={page.id}>
                  <NavLink
                    to={`/pages/${page.id}`}
                    className="orbit-nav-link"
                    title={page.description}
                    data-testid={`nav-custom-page-${page.id}`}
                  >
                    <span className="orbit-nav-link-inner">
                      <CUSTOM_PAGE_ICON size={18} aria-hidden="true" />
                      <span>{page.title}</span>
                    </span>
                  </NavLink>
                </li>
              ))}
              {renderNavItem(SETTINGS_NAV_ITEM)}
            </ul>
          </nav>
        </div>

        <NavLink
          to="/settings#feedback"
          className="orbit-rail__feedback"
          data-testid="nav-feedback"
        >
          <MessageSquareHeart size={15} aria-hidden="true" />
          <span>{t("shell.nav.feedback")}</span>
        </NavLink>

        <div className="orbit-rail__status-card">
          <div className="orbit-rail__status">
            <span
              className={orionOnline ? "orbit-status-dot orbit-status-dot--ok" : "orbit-status-dot"}
              aria-hidden="true"
            />
            <span>{t(orionOnline ? "shell.orion.online" : `shell.orion.${connState}`)}</span>
          </div>
          <span className="orbit-rail__status-sub">{t("shell.sync.savedLocally")}</span>
        </div>
      </aside>

      <header className="orbit-topbar">
        <div className="orbit-topbar__farm">
          <span className="orbit-topbar__name">{farmName}</span>
          <SyncStatusBadge />
        </div>

        <Button
          variant="subtle"
          size="sm"
          onClick={toggleTheme}
          aria-label={t(theme === "light" ? "shell.theme.toDark" : "shell.theme.toLight")}
          title={t(theme === "light" ? "shell.theme.darkTitle" : "shell.theme.lightTitle")}
          icon={theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
        >
          <span className="orbit-theme-toggle__label">
            {t(theme === "light" ? "shell.theme.dark" : "shell.theme.light")}
          </span>
        </Button>
      </header>

      <main className="orbit-main-scroll">
        <OrionConnectionBanner />
        {appUpdate.ready && (
          <div className="orbit-update-bar" role="status" data-testid="app-update-bar">
            <span>{t("shell.update.ready")}</span>
            <Button variant="primary" size="sm" onClick={appUpdate.restart}>
              {t("shell.update.restart")}
            </Button>
          </div>
        )}
        {localUiReady.ready && (
          <div className="orbit-update-bar" role="status" data-testid="local-ui-ready-bar">
            <span>{t("shell.localUi.ready")}</span>
            <Button
              variant="primary"
              size="sm"
              onClick={localUiReady.open}
              data-testid="local-ui-ready-open"
            >
              {t("shell.localUi.open")}
            </Button>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
