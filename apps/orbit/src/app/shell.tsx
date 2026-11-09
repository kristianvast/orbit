import {
  Camera,
  CheckCircle2,
  CloudOff,
  Home,
  MessageSquare,
  Moon,
  Radio,
  RefreshCw,
  Settings as SettingsIcon,
  Sun,
  Tag,
} from "lucide-react";
import { NavLink, Outlet } from "react-router";
import { Badge, Button } from "../design";
import { CUSTOM_PAGE_ICON, useCustomPages } from "../features/pages";
import { type MessageKey, useT } from "../i18n";
import { useLocalUiLifecycle } from "../lib/local-ui";
import { MODULE_IDS, type ModuleId, useModules } from "../lib/modules";
import { OrionConnectionBanner, useOrion, useOrionQuery } from "../lib/orion";
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

  if (connState !== "open") {
    return (
      <Badge variant="warn" icon={<CloudOff size={13} />}>
        {t("shell.sync.localWaiting")}
      </Badge>
    );
  }

  switch (syncStatus.state) {
    case "syncing":
    case "connecting":
      return (
        <Badge variant="info" icon={<RefreshCw size={13} className="orbit-spin" />}>
          {t("shell.sync.syncing", { count: syncStatus.pendingOutbox })}
        </Badge>
      );
    case "error":
      return (
        <Badge variant="danger" icon={<CloudOff size={13} />}>
          {t("shell.sync.error")}
        </Badge>
      );
    case "offline":
    case "disabled":
      return (
        <Badge variant="neutral" icon={<CloudOff size={13} />}>
          {t("shell.sync.savedLocally")}
        </Badge>
      );
    default:
      return (
        <Badge variant="ok" icon={<CheckCircle2 size={13} />}>
          {t("shell.sync.synced")}
        </Badge>
      );
  }
}

function BrandMark() {
  return (
    <svg
      className="orbit-brand__mark"
      width="22"
      height="22"
      viewBox="0 0 22 22"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="11" cy="11" r="4" fill="currentColor" />
      <ellipse
        cx="11"
        cy="11"
        rx="9.5"
        ry="4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        transform="rotate(-28 11 11)"
      />
      <circle cx="18.6" cy="6.4" r="2" fill="var(--accent-primary)" />
    </svg>
  );
}

export function AppShell() {
  const { state: connState } = useOrion();
  const { data: summary } = useOrionQuery("farm.summary");
  const { isEnabled } = useModules();
  const { theme, toggleTheme } = useTheme();
  const customPages = useCustomPages();
  const t = useT();
  useLocalUiLifecycle();

  const farmName = summary?.farm?.name ?? t("shell.farm.fallbackName");
  const alertCount = summary?.recentAlerts?.length ?? 0;
  const totalAnimals = (summary?.counts?.cattle ?? 0) + (summary?.counts?.horses ?? 0);
  const orionOnline = connState === "open";

  const topAndModuleNavItems: NavItem[] = [
    HOME_NAV_ITEM,
    CHAT_NAV_ITEM,
    ...MODULE_IDS.filter((id) => isEnabled(id)).map((id) => MODULE_NAV_ITEMS[id]),
  ];

  const renderNavItem = (item: NavItem) => {
    const Icon = item.icon;
    const count =
      item.to === "/" && alertCount > 0
        ? alertCount
        : item.to === "/herd" && totalAnimals > 0
          ? totalAnimals
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
            <span>{t(item.labelKey)}</span>
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

        <div className="orbit-rail__status">
          <span
            className={orionOnline ? "orbit-status-dot orbit-status-dot--ok" : "orbit-status-dot"}
            aria-hidden="true"
          />
          <span>{t(orionOnline ? "shell.orion.online" : `shell.orion.${connState}`)}</span>
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
        <Outlet />
      </main>
    </div>
  );
}
