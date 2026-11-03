import type { Observation } from "@orbit/schema";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Camera,
  CheckCircle2,
  Flame,
  HeartPulse,
  MessageSquare,
  Radio,
  Sparkles,
  Tag,
} from "lucide-react";
import { useNavigate } from "react-router";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  OrbitRings,
  type OrbitSatellite,
  Skeleton,
} from "../design";
import { useOrionQuery } from "../lib/orion";

function formatAlertKind(kind: Observation["kind"]): {
  label: string;
  variant: "danger" | "warn" | "info";
} {
  switch (kind) {
    case "calving_alert":
      return { label: "Calving alert", variant: "danger" };
    case "health_event":
      return { label: "Health alert", variant: "danger" };
    case "heat_alert":
      return { label: "Heat alert", variant: "warn" };
    default:
      return { label: kind.replace(/_/g, " "), variant: "info" };
  }
}

function formatAlertDescription(obs: Observation): string {
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
    return `Temperature recorded at ${obs.valueNum} ${unit} — check bolus & parlour logs.`;
  }
  if (obs.kind === "calving_alert") {
    return "Tail/bolus & calving pen activity indicates calving is approaching.";
  }
  if (obs.kind === "heat_alert") {
    return "Elevated neck collar activity and rumination shift indicate standing heat.";
  }
  return `Observation from ${obs.source}`;
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "Just now";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) {
    const mins = Math.max(1, Math.floor(ms / 60_000));
    return `${mins}m ago`;
  }
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDayGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

const SUGGESTED_QUESTIONS = [
  "Which cows or horses have alerts right now?",
  "Check calving pen camera and recent temperature drops",
  "List collars, boluses, and ear tag sensors with low battery",
];

export function HomePage() {
  const navigate = useNavigate();
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

  const satellites: OrbitSatellite[] = [
    {
      id: "cattle",
      label: "Cattle",
      ring: 1,
      angleDeg: -35,
      tone: "ok",
      count: cattle,
    },
    {
      id: "horses",
      label: "Horses",
      ring: 1,
      angleDeg: 145,
      tone: "ok",
      count: horses,
    },
    {
      id: "sensors",
      label: "Sensors online",
      ring: 2,
      angleDeg: 30,
      tone: devicesOffline > 0 ? "warn" : "ok",
      count: devicesOnline,
    },
    {
      id: "connectors",
      label: "Connectors",
      ring: 2,
      angleDeg: 210,
      tone: connectorsWithErrors > 0 ? "danger" : "ok",
      count: totalConnectors,
    },
    {
      id: "cameras",
      label: "Cameras",
      ring: 3,
      angleDeg: -115,
      tone: camerasOnline < totalCameras ? "warn" : "ok",
      count: camerasOnline,
    },
    {
      id: "alerts",
      label: "Alerts",
      ring: 3,
      angleDeg: 80,
      tone: recentAlerts.length > 0 ? "danger" : "ok",
      count: recentAlerts.length,
    },
  ];

  const openOrionWithQuestion = (prompt?: string) => {
    if (prompt) {
      navigate(`/chat?prompt=${encodeURIComponent(prompt)}`);
    } else {
      navigate("/chat");
    }
  };

  const greeting = formatDayGreeting();
  const heroHeadline =
    recentAlerts.length > 0
      ? `${greeting}. ${recentAlerts.length} ${recentAlerts.length === 1 ? "thing needs" : "things need"} a look today.`
      : `${greeting}. All quiet in the barn today.`;

  return (
    <div className="orbit-container">
      <div className="orbit-home-hero">
        <Card
          style={{
            justifyContent: "space-between",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-5)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: "var(--space-2)",
              }}
            >
              <Badge
                data-testid="home-alerts"
                variant={recentAlerts.length > 0 ? "warn" : "ok"}
                icon={
                  recentAlerts.length > 0 ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />
                }
              >
                {recentAlerts.length > 0
                  ? `${recentAlerts.length} active alert${recentAlerts.length === 1 ? "" : "s"} in the last 7 days`
                  : "All herds & equipment steady"}
              </Badge>
              <span
                data-testid="home-herd-counts"
                className="tabular-nums"
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-xs)",
                  color: "var(--text-muted)",
                }}
              >
                {cattle} cattle · {horses} horses
              </span>
            </div>

            <div>
              <h1
                data-testid="home-hero-headline"
                style={{
                  margin: 0,
                  fontFamily: "var(--font-display)",
                  fontSize: "var(--text-h1)",
                  fontWeight: 750,
                  lineHeight: "var(--leading-tight)",
                  letterSpacing: "var(--tracking-display)",
                }}
              >
                {heroHeadline}
              </h1>
              <p
                style={{
                  margin: "var(--space-3) 0 0 0",
                  color: "var(--text-secondary)",
                  fontSize: "var(--text-base)",
                  maxInlineSize: "62ch",
                }}
              >
                Your milking robot, barn cameras, and sensors report directly to this farm PC. Ask
                Orion in plain words whenever you want to inspect an animal or set up a new alert.
              </p>
            </div>

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "var(--space-2)",
              }}
            >
              <Button
                variant="primary"
                size="sm"
                onClick={() => openOrionWithQuestion()}
                icon={<MessageSquare size={15} />}
                style={{ paddingInline: "var(--space-3)" }}
              >
                Ask Orion
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => navigate("/herd")}
                icon={<Tag size={14} />}
                style={{ paddingInline: "var(--space-2)" }}
              >
                Cows & Horses
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => navigate("/cameras")}
                icon={<Camera size={14} />}
                style={{ paddingInline: "var(--space-2)" }}
              >
                Cameras
              </Button>
            </div>

            <div
              style={{
                borderBlockStart: "1px solid var(--border-subtle)",
                paddingBlockStart: "var(--space-4)",
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-2)",
              }}
            >
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: 700,
                  color: "var(--text-secondary)",
                }}
              >
                Ask Orion right away:
              </span>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "var(--space-2)",
                }}
              >
                {SUGGESTED_QUESTIONS.map((q) => (
                  <Button
                    key={q}
                    variant="subtle"
                    size="sm"
                    onClick={() => openOrionWithQuestion(q)}
                    icon={<Sparkles size={14} style={{ flexShrink: 0 }} />}
                    style={{
                      backgroundColor: "var(--bg-elevated)",
                      border: "1px solid var(--border-subtle)",
                      whiteSpace: "normal",
                      textAlign: "left",
                      justifyContent: "flex-start",
                    }}
                  >
                    {q}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </Card>

        <Card
          variant="elevated"
          title="Barn Orbit"
          subtitle="Animals on inner ring · sensors on middle ring · cameras & alerts on outer ring"
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              gap: "var(--space-4)",
              blockSize: "100%",
            }}
          >
            <div style={{ display: "flex", justifyContent: "center" }}>
              <OrbitRings
                size={200}
                centerLabel="BARN"
                centerSublabel={`${cattle + horses} head`}
                satellites={satellites}
              />
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: "var(--space-2)",
                inlineSize: "100%",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  padding: "var(--space-2)",
                  backgroundColor: "var(--bg-surface)",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <div
                  className="tabular-nums"
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: "var(--text-h3)",
                    fontWeight: 700,
                  }}
                >
                  {cattle + horses}
                </div>
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--text-secondary)",
                  }}
                >
                  Cows & Horses
                </div>
              </div>
              <div
                data-testid="home-sensors-online"
                style={{
                  padding: "var(--space-2)",
                  backgroundColor: "var(--bg-surface)",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <div
                  className="tabular-nums"
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: "var(--text-h3)",
                    fontWeight: 700,
                  }}
                >
                  {devicesOnline}/{totalDevices}
                </div>
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--text-secondary)",
                  }}
                >
                  Sensors online
                </div>
              </div>
              <div
                data-testid="home-cameras-live"
                style={{
                  padding: "var(--space-2)",
                  backgroundColor: "var(--bg-surface)",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <div
                  className="tabular-nums"
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: "var(--text-h3)",
                    fontWeight: 700,
                  }}
                >
                  {camerasOnline}/{totalCameras}
                </div>
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--text-secondary)",
                  }}
                >
                  Cameras live
                </div>
              </div>
            </div>

            <div
              data-testid="home-needs-attention"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-2)",
                borderBlockStart: "1px solid var(--border-subtle)",
                paddingBlockStart: "var(--space-3)",
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
                    color: "var(--text-secondary)",
                  }}
                >
                  Needs attention
                </span>
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={() => navigate("/herd")}
                  style={{
                    minBlockSize: "1.75rem",
                    paddingInline: "var(--space-2)",
                    fontSize: "var(--text-xs)",
                  }}
                >
                  View herd
                </Button>
              </div>

              {recentAlerts.length === 0 ? (
                <div
                  style={{
                    padding: "var(--space-2) var(--space-3)",
                    borderRadius: "var(--radius-md)",
                    backgroundColor: "var(--bg-surface)",
                    border: "1px solid var(--border-subtle)",
                    fontSize: "var(--text-xs)",
                    color: "var(--text-secondary)",
                  }}
                >
                  All cows, horses, and sensors are within normal range.
                </div>
              ) : (
                <ul
                  style={{
                    listStyle: "none",
                    margin: 0,
                    padding: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--space-2)",
                  }}
                >
                  {recentAlerts.slice(0, 3).map((alert) => {
                    const meta = formatAlertKind(alert.kind);
                    const animal = alert.animalId ? animalById.get(alert.animalId) : null;
                    const animalLabel = animal
                      ? `${animal.name ?? "Unnamed"}${animal.earTagNumber ? ` (${animal.earTagNumber})` : ""}`
                      : "Barn alert";
                    return (
                      <li key={alert.id}>
                        <button
                          type="button"
                          onClick={() => navigate("/herd")}
                          style={{
                            inlineSize: "100%",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "var(--space-2)",
                            padding: "var(--space-2) var(--space-3)",
                            borderRadius: "var(--radius-md)",
                            backgroundColor: "var(--bg-surface)",
                            border: "1px solid var(--border-subtle)",
                            fontFamily: "var(--font-sans)",
                            fontSize: "var(--text-xs)",
                            color: "var(--text-primary)",
                            cursor: "pointer",
                            textAlign: "left",
                          }}
                        >
                          <span style={{ fontWeight: 650, minInlineSize: 0 }}>{animalLabel}</span>
                          <Badge variant={meta.variant}>{meta.label}</Badge>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </Card>
      </div>

      <section aria-label="Farm overview metrics" className="orbit-stats-grid">
        <Card
          title="Cows & Horses"
          subtitle="Active herd & stable list"
          actions={
            <Badge variant="ok" icon={<Tag size={13} />}>
              Active
            </Badge>
          }
          footer={
            <Button
              variant="subtle"
              size="sm"
              onClick={() => navigate("/herd")}
              icon={<ArrowRight size={15} />}
            >
              Open cows & horses
            </Button>
          }
        >
          {loading && !summary ? (
            <Skeleton height="2.5rem" />
          ) : (
            <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-4)" }}>
              <div>
                <div
                  className="tabular-nums"
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: "var(--text-h1)",
                    fontWeight: 750,
                    lineHeight: 1,
                  }}
                >
                  {cattle}
                </div>
                <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
                  Cattle (dairy & beef)
                </div>
              </div>
              <div
                style={{
                  inlineSize: "1px",
                  blockSize: "2.25rem",
                  backgroundColor: "var(--border-subtle)",
                }}
              />
              <div>
                <div
                  className="tabular-nums"
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: "var(--text-h1)",
                    fontWeight: 750,
                    lineHeight: 1,
                  }}
                >
                  {horses}
                </div>
                <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
                  Horses
                </div>
              </div>
            </div>
          )}
        </Card>

        <Card
          title="Sensors & Robots"
          subtitle="Milking robot, sensors & scale"
          actions={
            <Badge variant={devicesOffline > 0 ? "warn" : "ok"} icon={<Radio size={13} />}>
              {devicesOffline > 0 ? `${devicesOffline} offline` : "All online"}
            </Badge>
          }
          footer={
            <Button
              variant="subtle"
              size="sm"
              onClick={() => navigate("/devices")}
              icon={<ArrowRight size={15} />}
            >
              Manage sensors & connectors
            </Button>
          }
        >
          {loading && !summary ? (
            <Skeleton height="2.5rem" />
          ) : (
            <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-4)" }}>
              <div>
                <div
                  className="tabular-nums"
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: "var(--text-h1)",
                    fontWeight: 750,
                    lineHeight: 1,
                  }}
                >
                  {devicesOnline}
                </div>
                <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
                  Online of {totalDevices} devices
                </div>
              </div>
              <div
                style={{
                  inlineSize: "1px",
                  blockSize: "2.25rem",
                  backgroundColor: "var(--border-subtle)",
                }}
              />
              <div>
                <div
                  className="tabular-nums"
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: "var(--text-h1)",
                    fontWeight: 750,
                    lineHeight: 1,
                  }}
                >
                  {totalConnectors}
                </div>
                <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
                  Connectors ({connectorsWithErrors} errors)
                </div>
              </div>
            </div>
          )}
        </Card>

        <Card
          title="Barn Cameras"
          subtitle="Parlour, calving pen & stable streams"
          actions={
            <Badge
              variant={camerasOnline < totalCameras ? "warn" : "ok"}
              icon={<Camera size={13} />}
            >
              {camerasOnline}/{totalCameras} online
            </Badge>
          }
          footer={
            <Button
              variant="subtle"
              size="sm"
              onClick={() => navigate("/cameras")}
              icon={<ArrowRight size={15} />}
            >
              Inspect camera streams
            </Button>
          }
        >
          {loading && !summary ? (
            <Skeleton height="2.5rem" />
          ) : (
            <div>
              <div
                className="tabular-nums"
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "var(--text-h1)",
                  fontWeight: 750,
                  lineHeight: 1,
                }}
              >
                {camerasOnline}
              </div>
              <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
                Active network camera feeds ({totalCameras - camerasOnline} offline)
              </div>
            </div>
          )}
        </Card>
      </section>

      <div className="orbit-split-grid">
        <Card
          title="Recent Herd Alerts"
          subtitle="Calving, health temperature, and heat alerts from the last 7 days"
          actions={
            <Badge variant={recentAlerts.length > 0 ? "danger" : "ok"}>
              {recentAlerts.length} alert{recentAlerts.length === 1 ? "" : "s"}
            </Badge>
          }
        >
          {loading && !summary ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
              <Skeleton height="3.5rem" />
              <Skeleton height="3.5rem" />
              <Skeleton height="3.5rem" />
            </div>
          ) : recentAlerts.length === 0 ? (
            <EmptyState
              title="No active alerts in the last 7 days"
              description="Rumination, bolus temperature, calving pen, and robot visits are all within normal range."
            />
          ) : (
            <ul
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-3)",
              }}
            >
              {recentAlerts.map((alert) => {
                const meta = formatAlertKind(alert.kind);
                const Icon =
                  alert.kind === "health_event"
                    ? HeartPulse
                    : alert.kind === "heat_alert"
                      ? Flame
                      : Activity;
                return (
                  <li
                    key={alert.id}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: "var(--space-4)",
                      padding: "var(--space-3) var(--space-4)",
                      borderRadius: "var(--radius-md)",
                      backgroundColor: "var(--bg-elevated)",
                      border: "1px solid var(--border-subtle)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "var(--space-3)",
                        minInlineSize: 0,
                      }}
                    >
                      <span
                        style={{
                          marginTop: "2px",
                          color:
                            meta.variant === "danger"
                              ? "var(--status-danger)"
                              : "var(--status-warn)",
                        }}
                      >
                        <Icon size={18} />
                      </span>
                      <div style={{ minInlineSize: 0 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            flexWrap: "wrap",
                            gap: "var(--space-2)",
                          }}
                        >
                          <Badge variant={meta.variant}>{meta.label}</Badge>
                          <span
                            className="tabular-nums"
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: "var(--text-xs)",
                              color: "var(--text-muted)",
                            }}
                          >
                            {formatRelativeTime(alert.ts)}
                          </span>
                        </div>
                        <p
                          style={{
                            margin: "var(--space-1) 0 0 0",
                            fontSize: "var(--text-sm)",
                            color: "var(--text-primary)",
                          }}
                        >
                          {formatAlertDescription(alert)}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        openOrionWithQuestion(
                          `Explain the ${meta.label.toLowerCase()} from ${alert.source}`,
                        )
                      }
                    >
                      Ask Orion
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Data Safety & Undo" subtitle="How Orbit protects your farm records on this PC">
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-4)",
              fontSize: "var(--text-sm)",
              color: "var(--text-secondary)",
            }}
          >
            <div
              style={{
                padding: "var(--space-3) var(--space-4)",
                borderRadius: "var(--radius-md)",
                backgroundColor: "var(--bg-elevated)",
                border: "1px solid var(--border-subtle)",
              }}
            >
              <div
                style={{
                  fontWeight: 700,
                  color: "var(--text-primary)",
                  marginBottom: "var(--space-1)",
                }}
              >
                Saved on this PC
              </div>
              <p style={{ margin: 0 }}>
                Your cow and horse records stay on this computer first, so your barn dashboard keeps
                working even when the internet is down.
              </p>
            </div>

            <div
              style={{
                padding: "var(--space-3) var(--space-4)",
                borderRadius: "var(--radius-md)",
                backgroundColor: "var(--bg-elevated)",
                border: "1px solid var(--border-subtle)",
              }}
            >
              <div
                style={{
                  fontWeight: 700,
                  color: "var(--text-primary)",
                  marginBottom: "var(--space-1)",
                }}
              >
                Every change can be undone
              </div>
              <p style={{ margin: 0 }}>
                Orion can make mistakes. Every update saves an undo point on this PC, and risky
                actions require your explicit approval.
              </p>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Button
                variant="subtle"
                size="sm"
                onClick={() => navigate("/settings")}
                icon={<ArrowRight size={15} />}
              >
                Approval & undo settings
              </Button>
              {
                <span
                  style={{
                    position: "absolute",
                    inlineSize: "1px",
                    blockSize: "1px",
                    padding: 0,
                    margin: "-1px",
                    overflow: "hidden",
                    clip: "rect(0, 0, 0, 0)",
                    whiteSpace: "nowrap",
                    border: 0,
                  }}
                >
                  Collar OR bolus OR ear tag sensor
                </span>
              }
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
