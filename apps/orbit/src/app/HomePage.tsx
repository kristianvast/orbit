import type { Observation, WearableKind } from "@orbit/schema";
import {
  Activity,
  AlertTriangle,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Flame,
  HeartPulse,
  Mic,
  ShieldCheck,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Badge, Button, EmptyState, OrbitRings, type OrbitSatellite, Skeleton } from "../design";
import { PageCards, useCustomPages } from "../features/pages";
import { type MessageKey, type TranslateFn, useI18n } from "../i18n";
import { type ModuleId, useModules } from "../lib/modules";
import { useOrion, useOrionQuery } from "../lib/orion";
import { useNeedsSetup } from "../lib/setup";
import { formatPrimaryAnimalCount, useFarmSpecies } from "../lib/species";
import { useTheme } from "./providers";
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

function formatWearableChip(kind: WearableKind, batteryPct: number | null, t: TranslateFn): string {
  const label =
    kind === "collar"
      ? t("herd.wearable.collar")
      : kind === "bolus"
        ? t("herd.wearable.bolus")
        : t("herd.wearable.ear_tag_sensor");
  if (batteryPct !== null && Number.isFinite(batteryPct)) {
    return `${label} · ${Math.round(batteryPct)}%`;
  }
  return label;
}

interface Instrument {
  id: string;
  moduleId: ModuleId;
  label: string;
  value: string;
  detail: string;
  tone: "ok" | "warn" | "danger";
  to: string;
  testId?: string;
}

const GROUP_PALETTE = [
  "var(--accent-secondary)",
  "var(--accent-primary)",
  "var(--border-control)",
  "var(--status-info)",
] as const;

export function HomePage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [question, setQuestion] = useState("");
  const { loading: modulesLoading, isEnabled, anyEnabled } = useModules();
  const { species } = useFarmSpecies();
  const customPages = useCustomPages();
  const { theme } = useTheme();

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

  const herdEnabled = isEnabled("herd");
  const devicesEnabled = isEnabled("devices");
  const camerasEnabled = isEnabled("cameras");

  const { data: animalsData } = useOrionQuery(
    "animals.list",
    { limit: 500 },
    { enabled: herdEnabled, refetchTables: ["animals", "device_bindings", "devices"] },
  );

  const animalRows = animalsData?.rows ?? [];
  const animalById = useMemo(() => new Map(animalRows.map((a) => [a.id, a])), [animalRows]);

  const groupSegments = useMemo(() => {
    const active = animalRows.filter((a) => a.status === "active" && a.species === species);
    if (active.length === 0) return [];
    const counts = new Map<string, number>();
    for (const a of active) {
      const key = a.groupName?.trim() || t("herd.animal.ungrouped");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, count], idx) => ({
        name,
        count,
        color: GROUP_PALETTE[idx % GROUP_PALETTE.length],
      }));
  }, [animalRows, species, t]);

  const cattle = summary?.counts?.cattle ?? 0;
  const horses = summary?.counts?.horses ?? 0;
  const totalAnimals = cattle + horses;
  const primaryAnimals =
    species === "horse" ? (horses > 0 ? horses : cattle) : cattle > 0 ? cattle : horses;
  const totalDevices = summary?.counts?.devices ?? 0;
  const devicesOffline = summary?.counts?.devicesOffline ?? 0;
  const devicesOnline = Math.max(0, totalDevices - devicesOffline);
  const totalCameras = summary?.counts?.cameras ?? 0;
  const camerasOnline = summary?.counts?.camerasOnline ?? 0;
  const totalConnectors = summary?.counts?.connectors ?? 0;
  const connectorsWithErrors = summary?.counts?.connectorsWithErrors ?? 0;
  const recentAlerts = summary?.recentAlerts ?? [];
  const isLoading = (loading && !summary) || modulesLoading;

  const isMinimalHome = !isLoading && !anyEnabled && totalAnimals === 0;
  const orionOnline = useOrion().state === "open";
  const needsSetup = useNeedsSetup();
  const isHorse = species === "horse";

  const suggestedQuestions: readonly MessageKey[] = isHorse
    ? ["home.suggest.alerts.horse", "home.suggest.calving.horse", "home.suggest.battery"]
    : ["home.suggest.alerts.cattle", "home.suggest.calving", "home.suggest.battery"];

  const minimalStarters: ReadonlyArray<{
    id: string;
    labelKey: MessageKey;
    promptKey: MessageKey;
  }> = [
    {
      id: "herd",
      labelKey: isHorse
        ? "home.minimal.starter.herd.label.horse"
        : "home.minimal.starter.herd.label",
      promptKey: isHorse
        ? "home.minimal.starter.herd.prompt.horse"
        : "home.minimal.starter.herd.prompt",
    },
    {
      id: "devices",
      labelKey: isHorse
        ? "home.minimal.starter.devices.label.horse"
        : "home.minimal.starter.devices.label",
      promptKey: isHorse
        ? "home.minimal.starter.devices.prompt.horse"
        : "home.minimal.starter.devices.prompt",
    },
    {
      id: "cameras",
      labelKey: isHorse
        ? "home.minimal.starter.cameras.label.horse"
        : "home.minimal.starter.cameras.label",
      promptKey: isHorse
        ? "home.minimal.starter.cameras.prompt.horse"
        : "home.minimal.starter.cameras.prompt",
    },
    {
      id: "page",
      labelKey: "home.minimal.starter.page.label",
      promptKey: "home.minimal.starter.page.prompt",
    },
  ];

  const openOrionWithQuestion = (prompt?: string) => {
    const trimmed = prompt?.trim();
    if (trimmed) {
      navigate(`/chat?prompt=${encodeURIComponent(trimmed)}&send=1`, {
        state: { prefill: trimmed },
      });
    } else {
      navigate("/chat");
    }
  };

  const submitQuestion = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    openOrionWithQuestion(question);
  };

  if (isMinimalHome) {
    return (
      <div className="orbit-container orbit-home orbit-home--minimal" data-testid="home-minimal">
        <header className="orbit-home__head orbit-home__head--minimal">
          {orionOnline && !needsSetup && (
            <div className="orbit-home__meta">
              <Badge variant="ok" icon={<CheckCircle2 size={13} />} data-testid="home-alerts">
                {t("home.minimal.badge")}
              </Badge>
            </div>
          )}

          <h1 data-testid="home-hero-headline" className="orbit-home__headline">
            {t("home.minimal.headline")}
          </h1>

          <p className="orbit-home__lede" data-testid="home-minimal-lede">
            {t(isHorse ? "home.minimal.lede.horse" : "home.minimal.lede.cattle")}
          </p>

          {needsSetup ? (
            <section className="orbit-setup" data-testid="home-setup">
              <h2 className="orbit-setup__title">{t("home.setup.title")}</h2>
              <p className="orbit-setup__body">{t("home.setup.body")}</p>
              <div className="orbit-setup__actions">
                <Button
                  variant="primary"
                  onClick={() =>
                    void navigate("/settings#account", { state: { accountMode: "register" } })
                  }
                  data-testid="home-setup-create"
                >
                  {t("home.setup.create")}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void navigate("/settings#account")}
                  data-testid="home-setup-sign-in"
                >
                  {t("home.setup.signIn")}
                </Button>
              </div>
              <Link
                to="/settings#providers"
                className="orbit-setup__alt"
                data-testid="home-setup-own-key"
              >
                {t("home.setup.ownKey")}
              </Link>
            </section>
          ) : (
            <>
              <form className="orbit-ask orbit-ask--hero" onSubmit={submitQuestion}>
                <label htmlFor="home-ask-orion" className="orbit-visually-hidden">
                  {t("home.ask.label")}
                </label>
                <input
                  id="home-ask-orion"
                  data-testid="home-ask-input"
                  className="orbit-ask__input"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder={t("home.minimal.placeholder")}
                  autoComplete="off"
                />
                <Button
                  type="submit"
                  variant="primary"
                  icon={<ArrowUp size={16} />}
                  data-testid="home-ask-submit"
                >
                  {t("home.ask.submit")}
                </Button>
              </form>

              <ul
                className="orbit-starter-grid"
                aria-label={t("home.minimal.startersLabel")}
                data-testid="home-starter-chips"
              >
                {minimalStarters.map((starter) => (
                  <li key={starter.id}>
                    <button
                      type="button"
                      className="orbit-starter-tile"
                      data-testid={`home-starter-${starter.id}`}
                      onClick={() => openOrionWithQuestion(t(starter.promptKey))}
                    >
                      <span>{t(starter.labelKey)}</span>
                      <ChevronRight size={15} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </header>

        <PageCards pages={customPages} theme={theme} />

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

  const satellites: OrbitSatellite[] = [
    ...(herdEnabled || totalAnimals > 0
      ? ([
          {
            id: isHorse ? "horses" : "cattle",
            label: t(isHorse ? "home.orbit.horses" : "home.orbit.cattle"),
            ring: 1 as const,
            angleDeg: -35,
            tone: "ok" as const,
            count: primaryAnimals,
          },
        ] satisfies OrbitSatellite[])
      : []),
    ...(devicesEnabled
      ? ([
          {
            id: "sensors",
            label: t("home.orbit.sensors"),
            ring: 2 as const,
            angleDeg: 30,
            tone: devicesOffline > 0 ? ("warn" as const) : ("ok" as const),
            count: devicesOnline,
          },
          {
            id: "connectors",
            label: t("home.orbit.connectors"),
            ring: 2 as const,
            angleDeg: 210,
            tone: connectorsWithErrors > 0 ? ("danger" as const) : ("ok" as const),
            count: totalConnectors,
          },
        ] satisfies OrbitSatellite[])
      : []),
    ...(camerasEnabled
      ? ([
          {
            id: "cameras",
            label: t("home.orbit.cameras"),
            ring: 3 as const,
            angleDeg: -115,
            tone: camerasOnline < totalCameras ? ("warn" as const) : ("ok" as const),
            count: camerasOnline,
          },
        ] satisfies OrbitSatellite[])
      : []),
    {
      id: "alerts",
      label: t("home.orbit.alerts"),
      ring: 3,
      angleDeg: 80,
      tone: recentAlerts.length > 0 ? "danger" : "ok",
      count: recentAlerts.length,
    },
  ];

  const allInstruments: Instrument[] = [
    {
      id: "animals",
      moduleId: "herd",
      label: t(isHorse ? "home.gauge.animals.horse" : "home.gauge.animals.cattle"),
      value: String(primaryAnimals),
      detail: t(isHorse ? "home.gauge.animalsDetail.horse" : "home.gauge.animalsDetail.cattle", {
        count: primaryAnimals,
      }),
      tone: "ok",
      to: "/herd",
      testId: "home-animals-gauge",
    },
    {
      id: "sensors",
      moduleId: "devices",
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
      moduleId: "cameras",
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
      moduleId: "devices",
      label: t("home.gauge.connectors"),
      value: String(totalConnectors),
      detail:
        connectorsWithErrors > 0
          ? t("home.gauge.connectorErrors", { count: connectorsWithErrors })
          : t("home.gauge.connectorsSynced"),
      tone: connectorsWithErrors > 0 ? "danger" : "ok",
      to: "/devices",
      testId: "home-connectors-gauge",
    },
  ];

  const instruments = allInstruments.filter(
    (ins) => isEnabled(ins.moduleId) || (ins.moduleId === "herd" && totalAnimals > 0),
  );

  const heroHeadline = !summary
    ? t("home.hero.waiting")
    : recentAlerts.length > 0
      ? t("home.hero.alerts", { count: recentAlerts.length })
      : t("home.hero.quiet");

  return (
    <div className="orbit-container orbit-home">
      <header className="orbit-home__head">
        <div className="orbit-home__masthead">
          <div className="orbit-home__masthead-main">
            <div className="orbit-home__meta">
              {summary && (
                <Badge
                  data-testid="home-alerts"
                  variant={recentAlerts.length > 0 ? "warn" : "ok"}
                  icon={
                    recentAlerts.length > 0 ? (
                      <AlertTriangle size={13} />
                    ) : (
                      <CheckCircle2 size={13} />
                    )
                  }
                >
                  {recentAlerts.length > 0
                    ? t("home.badge.alerts", { count: recentAlerts.length })
                    : t("home.badge.steady")}
                </Badge>
              )}
              {(herdEnabled || totalAnimals > 0) && (
                <span data-testid="home-herd-counts" className="orbit-home__counts">
                  {formatPrimaryAnimalCount(cattle, horses, species, t)}
                </span>
              )}
            </div>

            <h1 data-testid="home-hero-headline" className="orbit-home__headline">
              {heroHeadline}
            </h1>
          </div>

          {summary && (herdEnabled || devicesEnabled || camerasEnabled || totalAnimals > 0) && (
            <dl className="orbit-telemetry">
              {(herdEnabled || totalAnimals > 0) && (
                <div className="orbit-telemetry__item">
                  <dd className="orbit-telemetry__value tabular-nums">{primaryAnimals}</dd>
                  <dt className="orbit-telemetry__label">
                    {t(isHorse ? "home.telemetry.horses" : "home.telemetry.cattle")}
                  </dt>
                </div>
              )}
              {devicesEnabled && (
                <div className="orbit-telemetry__item">
                  <dd className="orbit-telemetry__value tabular-nums">
                    {devicesOnline}/{totalDevices}
                  </dd>
                  <dt className="orbit-telemetry__label">{t("home.telemetry.sensors")}</dt>
                </div>
              )}
              {camerasEnabled && (
                <div className="orbit-telemetry__item">
                  <dd className="orbit-telemetry__value tabular-nums">
                    {camerasOnline}/{totalCameras}
                  </dd>
                  <dt className="orbit-telemetry__label">{t("home.telemetry.cameras")}</dt>
                </div>
              )}
            </dl>
          )}
        </div>

        <form className="orbit-ask" onSubmit={submitQuestion}>
          <label htmlFor="home-ask-orion" className="orbit-visually-hidden">
            {t("home.ask.label")}
          </label>
          <input
            id="home-ask-orion"
            data-testid="home-ask-input"
            className="orbit-ask__input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={t("home.ask.placeholder")}
            autoComplete="off"
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={<Mic size={15} />}
            onClick={() => navigate("/chat")}
            data-testid="home-voice-btn"
          >
            {t("home.ask.voice")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            icon={<ArrowUp size={16} />}
            data-testid="home-ask-submit"
          >
            {t("home.ask.submit")}
          </Button>
        </form>

        <ul className="orbit-ask__suggestions" aria-label={t("home.ask.suggestions")}>
          {suggestedQuestions.map((key) => (
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
                        {animal?.wearable && (
                          <span className="orbit-alert__wearable">
                            {formatWearableChip(
                              animal.wearable.kind,
                              animal.wearable.batteryPct,
                              t,
                            )}
                          </span>
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

        {instruments.length > 0 && (
          <section className="orbit-card orbit-home__panel" aria-labelledby="home-status-title">
            <div className="orbit-home__panel-head">
              <h2 id="home-status-title" className="orbit-home__panel-title">
                {t("home.status.title")}
              </h2>
            </div>

            <div className="orbit-home__rings">
              <OrbitRings
                size={188}
                centerLabel={t(isHorse ? "home.status.center.horse" : "home.status.center")}
                centerSublabel={t("home.status.head", { count: primaryAnimals })}
                satellites={satellites}
              />
            </div>

            {groupSegments.length > 0 && (
              <div className="orbit-herd-composition">
                <div className="orbit-herd-composition__legend">
                  {groupSegments.map((seg) => (
                    <span key={seg.name} className="orbit-herd-composition__item tabular-nums">
                      <span
                        className="orbit-herd-composition__swatch"
                        style={{ backgroundColor: seg.color }}
                        aria-hidden="true"
                      />
                      <span>
                        {seg.name} {seg.count}
                      </span>
                    </span>
                  ))}
                </div>
                <div className="orbit-herd-composition__bar" aria-hidden="true">
                  {groupSegments.map((seg) => (
                    <span key={seg.name} style={{ flex: seg.count, backgroundColor: seg.color }} />
                  ))}
                </div>
              </div>
            )}

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
        )}
      </div>

      <PageCards pages={customPages} theme={theme} />

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
