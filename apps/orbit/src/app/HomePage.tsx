import type { Observation } from "@orbit/schema";
import {
  Activity,
  AlertTriangle,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Flame,
  HeartPulse,
  ShieldCheck,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Badge, Button, EmptyState, OrbitRings, type OrbitSatellite, Skeleton } from "../design";
import { type MessageKey, type TranslateFn, useT } from "../i18n";
import { useOrionQuery } from "../lib/orion";
import "./home.css";

function formatAlertKind(
  kind: Observation["kind"],
  t: TranslateFn,
): {
  label: string;
  variant: "danger" | "warn" | "info";
} {
  switch (kind) {
    case "calving_alert":
      return { label: t("home.alertKind.calving"), variant: "danger" };
    case "health_event":
      return { label: t("home.alertKind.health"), variant: "danger" };
    case "heat_alert":
      return { label: t("home.alertKind.heat"), variant: "warn" };
    default:
      return { label: kind.replace(/_/g, " "), variant: "info" };
  }
}

function formatAlertDescription(obs: Observation, t: TranslateFn): string {
  const val = obs.valueJson ?? {};
  const note =
    typeof val.note === "string"
      ? val.note
      : typeof val.summary === "string"
        ? val.summary
        : typeof val.message === "string"
          ? val.message
          : null;
  if (note) return note;

  if (obs.kind === "health_event" && obs.valueNum !== null) {
    const unit = typeof val.unit === "string" ? val.unit : "°C";
    return t("home.desc.temperature", { value: obs.valueNum, unit });
  }
  if (obs.kind === "calving_alert") {
    return t("home.desc.calving");
  }
  if (obs.kind === "heat_alert") {
    return t("home.desc.heat");
  }
  return t("home.desc.source", { source: obs.source });
}

function formatRelativeTime(iso: string, t: TranslateFn): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return t("home.time.justNow");
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) {
    const mins = Math.max(1, Math.floor(ms / 60_000));
    return t("home.time.minutes", { count: mins });
  }
  if (hours < 24) return t("home.time.hours", { count: hours });
  const days = Math.floor(hours / 24);
  return t("home.time.days", { count: days });
}

const SUGGESTED_QUESTIONS: readonly MessageKey[] = [
  "home.suggest.alerts",
  "home.suggest.calving",
  "home.suggest.battery",
];

interface Instrument {
  id: string;
  label: string;
  value: string;
  detail: string;
  tone: "ok" | "warn" | "danger";
  to: string;
  testId?: string;
}

export function HomePage() {
  const navigate = useNavigate();
  const t = useT();
  const [question, setQuestion] = useState("");
  const { data: summary, loading } = useOrionQuery("farm.summary", undefined, {
    refetchTables: [
      "farms",
      "animals",
      "devices",
      "device_bindings",
      "cameras",
      "connectors",
      "observations",
    ],
  });

  const { data: animalsData } = useOrionQuery(
    "animals.list",
    { limit: 500 },
    { refetchTables: ["animals"] },
  );

  const animalById = new Map((animalsData?.rows ?? []).map((a) => [a.id, a]));

  const cattle = summary?.counts?.cattle ?? 0;
  const horses = summary?.counts?.horses ?? 0;
  const totalDevices = summary?.counts?.devices ?? 0;
  const devicesOffline = summary?.counts?.devicesOffline ?? 0;
  const devicesOnline = Math.max(0, totalDevices - devicesOffline);
  const totalCameras = summary?.counts?.cameras ?? 0;
  const camerasOnline = summary?.counts?.camerasOnline ?? 0;
  const totalConnectors = summary?.counts?.connectors ?? 0;
  const connectorsWithErrors = summary?.counts?.connectorsWithErrors ?? 0;
  const recentAlerts = summary?.recentAlerts ?? [];
  const isLoading = loading && !summary;

  const satellites: OrbitSatellite[] = [
    {
      id: "cattle",
      label: t("home.orbit.cattle"),
      ring: 1,
      angleDeg: -35,
      tone: "ok",
      count: cattle,
    },
    {
      id: "horses",
      label: t("home.orbit.horses"),
      ring: 1,
      angleDeg: 145,
      tone: "ok",
      count: horses,
    },
    {
      id: "sensors",
      label: t("home.orbit.sensors"),
      ring: 2,
      angleDeg: 30,
      tone: devicesOffline > 0 ? "warn" : "ok",
      count: devicesOnline,
    },
    {
      id: "connectors",
      label: t("home.orbit.connectors"),
      ring: 2,
      angleDeg: 210,
      tone: connectorsWithErrors > 0 ? "danger" : "ok",
      count: totalConnectors,
    },
    {
      id: "cameras",
      label: t("home.orbit.cameras"),
      ring: 3,
      angleDeg: -115,
      tone: camerasOnline < totalCameras ? "warn" : "ok",
      count: camerasOnline,
    },
    {
      id: "alerts",
      label: t("home.orbit.alerts"),
      ring: 3,
      angleDeg: 80,
      tone: recentAlerts.length > 0 ? "danger" : "ok",
      count: recentAlerts.length,
    },
  ];

  const instruments: Instrument[] = [
    {
      id: "animals",
      label: t("home.gauge.animals"),
      value: String(cattle + horses),
      detail: t("home.gauge.animalsDetail", { cattle, horses }),
      tone: "ok",
      to: "/herd",
    },
    {
      id: "sensors",
      label: t("home.gauge.sensors"),
      value: `${devicesOnline}/${totalDevices}`,
      detail:
        devicesOffline > 0
          ? t("home.gauge.offline", { count: devicesOffline })
          : t("home.gauge.allReporting"),
      tone: devicesOffline > 0 ? "warn" : "ok",
      to: "/devices",
      testId: "home-sensors-online",
    },
    {
      id: "cameras",
      label: t("home.gauge.cameras"),
      value: `${camerasOnline}/${totalCameras}`,
      detail:
        totalCameras - camerasOnline > 0
          ? t("home.gauge.offline", { count: totalCameras - camerasOnline })
          : t("home.gauge.allStreaming"),
      tone: camerasOnline < totalCameras ? "warn" : "ok",
      to: "/cameras",
      testId: "home-cameras-live",
    },
    {
      id: "connectors",
      label: t("home.gauge.connectors"),
      value: String(totalConnectors),
      detail:
        connectorsWithErrors > 0
          ? t("home.gauge.connectorErrors", { count: connectorsWithErrors })
          : t("home.gauge.connectorsSynced"),
      tone: connectorsWithErrors > 0 ? "danger" : "ok",
      to: "/devices",
    },
  ];

  const openOrionWithQuestion = (prompt?: string) => {
    const trimmed = prompt?.trim();
    navigate(trimmed ? `/chat?prompt=${encodeURIComponent(trimmed)}` : "/chat");
  };

  const submitQuestion = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    openOrionWithQuestion(question);
  };

  const heroHeadline =
    recentAlerts.length > 0
      ? t("home.hero.alerts", { count: recentAlerts.length })
      : t("home.hero.quiet");

  return (
    <div className="orbit-container orbit-home">
      <header className="orbit-home__head">
        <div className="orbit-home__meta">
          <Badge
            data-testid="home-alerts"
            variant={recentAlerts.length > 0 ? "warn" : "ok"}
            icon={
              recentAlerts.length > 0 ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />
            }
          >
            {recentAlerts.length > 0
              ? t("home.badge.alerts", { count: recentAlerts.length })
              : t("home.badge.steady")}
          </Badge>
          <span data-testid="home-herd-counts" className="orbit-home__counts">
            {t("home.counts", { cattle, horses })}
          </span>
        </div>

        <h1 data-testid="home-hero-headline" className="orbit-home__headline">
          {heroHeadline}
        </h1>

        <form className="orbit-ask" onSubmit={submitQuestion}>
          <label htmlFor="home-ask-orion" className="orbit-visually-hidden">
            {t("home.ask.label")}
          </label>
          <input
            id="home-ask-orion"
            className="orbit-ask__input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={t("home.ask.placeholder")}
            autoComplete="off"
          />
          <Button type="submit" variant="primary" icon={<ArrowUp size={16} />}>
            {t("home.ask.submit")}
          </Button>
        </form>

        <ul className="orbit-ask__suggestions" aria-label={t("home.ask.suggestions")}>
          {SUGGESTED_QUESTIONS.map((key) => (
            <li key={key}>
              <button
                type="button"
                className="orbit-ask__suggestion"
                onClick={() => openOrionWithQuestion(t(key))}
              >
                {t(key)}
              </button>
            </li>
          ))}
        </ul>
      </header>

      <div className="orbit-home__grid">
        <section className="orbit-card orbit-home__panel" aria-labelledby="home-alerts-title">
          <div className="orbit-home__panel-head">
            <h2 id="home-alerts-title" className="orbit-home__panel-title">
              {t("home.alerts.title")}
            </h2>
            <span className="orbit-home__panel-meta">{t("home.alerts.period")}</span>
          </div>

          {isLoading ? (
            <div className="orbit-home__skeletons">
              <Skeleton height="3.5rem" />
              <Skeleton height="3.5rem" />
              <Skeleton height="3.5rem" />
            </div>
          ) : recentAlerts.length === 0 ? (
            <EmptyState
              title={t("home.alerts.emptyTitle")}
              description={t("home.alerts.emptyDescription")}
            />
          ) : (
            <ul className="orbit-alert-list">
              {recentAlerts.map((alert) => {
                const meta = formatAlertKind(alert.kind, t);
                const animal = alert.animalId ? animalById.get(alert.animalId) : null;
                const animalLabel = animal
                  ? (animal.name ?? t("home.alerts.unnamed"))
                  : t("home.alerts.barn");
                const Icon =
                  alert.kind === "health_event"
                    ? HeartPulse
                    : alert.kind === "heat_alert"
                      ? Flame
                      : Activity;
                return (
                  <li key={alert.id} className="orbit-alert" data-tone={meta.variant}>
                    <span className="orbit-alert__icon" aria-hidden="true">
                      <Icon size={18} />
                    </span>
                    <div className="orbit-alert__body">
                      <div className="orbit-alert__title-row">
                        <span className="orbit-alert__animal">{animalLabel}</span>
                        {animal?.earTagNumber && (
                          <span className="orbit-alert__tag">{animal.earTagNumber}</span>
                        )}
                        <span className="orbit-alert__kind">{meta.label}</span>
                        <span className="orbit-alert__time">{formatRelativeTime(alert.ts, t)}</span>
                      </div>
                      <p className="orbit-alert__desc">{formatAlertDescription(alert, t)}</p>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={t("home.alerts.askAria", {
                        animal: animalLabel,
                        kind: meta.label.toLowerCase(),
                      })}
                      onClick={() =>
                        openOrionWithQuestion(
                          t("home.alerts.askPrompt", {
                            kind: meta.label.toLowerCase(),
                            source: alert.source,
                          }),
                        )
                      }
                    >
                      {t("home.alerts.ask")}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="orbit-card orbit-home__panel" aria-labelledby="home-status-title">
          <div className="orbit-home__panel-head">
            <h2 id="home-status-title" className="orbit-home__panel-title">
              {t("home.status.title")}
            </h2>
          </div>

          <div className="orbit-home__rings">
            <OrbitRings
              size={184}
              centerLabel={t("home.status.center")}
              centerSublabel={t("home.status.head", { count: cattle + horses })}
              satellites={satellites}
            />
          </div>

          <ul className="orbit-gauges">
            {instruments.map((ins) => (
              <li key={ins.id}>
                <button
                  type="button"
                  className="orbit-gauge"
                  data-testid={ins.testId}
                  onClick={() => navigate(ins.to)}
                >
                  <span className="orbit-gauge__label">{ins.label}</span>
                  {isLoading ? (
                    <Skeleton width="3rem" height="1.5rem" />
                  ) : (
                    <span className="orbit-gauge__value">{ins.value}</span>
                  )}
                  <span className="orbit-gauge__detail" data-tone={ins.tone}>
                    {ins.detail}
                  </span>
                  <ChevronRight size={16} className="orbit-gauge__chevron" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <p className="orbit-home__note">
        <ShieldCheck size={16} aria-hidden="true" />
        <span>
          {t("home.note.body")} <Link to="/settings">{t("home.note.undo")}</Link>
        </span>
        <span className="orbit-visually-hidden">{t("home.note.wearable")}</span>
      </p>
    </div>
  );
}
