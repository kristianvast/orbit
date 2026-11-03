import {
  Camera,
  CheckCircle2,
  CloudOff,
  Home,
  MessageSquare,
  Moon,
  Orbit as OrbitIcon,
  Radio,
  RefreshCw,
  Settings as SettingsIcon,
  Sun,
  Tag,
} from "lucide-react";
import { NavLink, Outlet } from "react-router";
import { Badge, Button } from "../design";
import { OrionConnectionBanner, useOrion, useOrionQuery } from "../lib/orion";
import { useTheme } from "./providers";

export interface NavItem {
  to: string;
  label: string;
  end?: boolean;
  icon: typeof Home;
}

export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Home", end: true, icon: Home },
  { to: "/chat", label: "Ask Orion", icon: MessageSquare },
  { to: "/herd", label: "Cows & Horses", icon: Tag },
  { to: "/devices", label: "Sensors & Robots", icon: Radio },
  { to: "/cameras", label: "Cameras", icon: Camera },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

function SyncStatusBadge() {
  const { state: connState, syncStatus } = useOrion();

  if (connState !== "open") {
    return (
      <Badge variant="warn" icon={<CloudOff size={13} />}>
        Local waiting
      </Badge>
    );
  }

  switch (syncStatus.state) {
    case "syncing":
    case "connecting":
      return (
        <Badge variant="info" icon={<RefreshCw size={13} className="orbit-spin" />}>
          Syncing ({syncStatus.pendingOutbox})
        </Badge>
      );
    case "error":
      return (
        <Badge variant="danger" icon={<CloudOff size={13} />}>
          Sync error
        </Badge>
      );
    case "offline":
    case "disabled":
      return (
        <Badge variant="neutral" icon={<CloudOff size={13} />}>
          Saved on this PC
        </Badge>
      );
    default:
      return (
        <Badge variant="ok" icon={<CheckCircle2 size={13} />}>
          Synced
        </Badge>
      );
  }
}

export function AppShell() {
  const { state: connState } = useOrion();
  const { data: summary } = useOrionQuery("farm.summary");
  const { theme, toggleTheme } = useTheme();

  const farmName = summary?.farm?.name ?? "North Ridge Barn";
  const alertCount = summary?.recentAlerts?.length ?? 0;
  const totalAnimals = (summary?.counts?.cattle ?? 0) + (summary?.counts?.horses ?? 0);

  return (
    <div className="orbit-shell">
      <aside className="orbit-rail" aria-label="Primary farm navigation">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-3)",
              paddingInline: "var(--space-2)",
            }}
          >
            <div
              style={{
                inlineSize: "2.5rem",
                blockSize: "2.5rem",
                borderRadius: "var(--radius-md)",
                backgroundColor: "var(--accent-primary)",
                color: "var(--text-inverse)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <OrbitIcon size={22} />
            </div>
            <div style={{ minInlineSize: 0 }}>
              <div
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "var(--text-h3)",
                  fontWeight: 750,
                  lineHeight: 1.1,
                  letterSpacing: "var(--tracking-heading)",
                }}
              >
                Orbit
              </div>
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--text-secondary)",
                }}
              >
                Farm desktop
              </div>
            </div>
          </div>

          <nav aria-label="Main">
            <ul className="orbit-nav-list">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const badgeCount =
                  item.to === "/" && alertCount > 0
                    ? alertCount
                    : item.to === "/herd" && totalAnimals > 0
                      ? totalAnimals
                      : null;
                return (
                  <li key={item.to}>
                    <NavLink to={item.to} end={item.end} className="orbit-nav-link">
                      <span className="orbit-nav-link-inner">
                        <Icon size={20} aria-hidden="true" />
                        <span>{item.label}</span>
                      </span>
                      {badgeCount !== null && (
                        <Badge
                          variant={item.to === "/" ? "warn" : "neutral"}
                          className="tabular-nums"
                        >
                          {badgeCount}
                        </Badge>
                      )}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>

        <div
          className="orbit-card orbit-card--subtle"
          style={{
            padding: "var(--space-3) var(--space-4)",
            gap: "var(--space-2)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "var(--space-2)",
            }}
          >
            <span
              style={{
                fontSize: "var(--text-xs)",
                fontWeight: 700,
                color: "var(--text-primary)",
              }}
            >
              Orion assistant
            </span>
            <Badge variant={connState === "open" ? "ok" : "warn"}>
              {connState === "open" ? "Online" : connState}
            </Badge>
          </div>
        </div>
      </aside>

      <header className="orbit-topbar">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            minInlineSize: 0,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "var(--text-lg)",
              fontWeight: 700,
              color: "var(--text-primary)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {farmName}
          </span>
          <SyncStatusBadge />
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
          }}
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={toggleTheme}
            aria-label={
              theme === "light"
                ? "Switch to night watch dark theme"
                : "Switch to daylight barn light theme"
            }
            icon={theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
          >
            {theme === "light" ? "Night watch" : "Daylight"}
          </Button>
        </div>
      </header>

      <main className="orbit-main-scroll">
        <OrionConnectionBanner />
        <div style={{ paddingTop: "var(--space-2)" }}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
