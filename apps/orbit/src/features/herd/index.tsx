import type { ActiveWearable, AnimalInput, DeviceListItem } from "@orbit/protocol";
import type { Animal, AnimalSex, AnimalStatus, Observation, Species } from "@orbit/schema";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Battery,
  Edit3,
  Eye,
  LayoutGrid,
  Link2,
  MessageSquare,
  Orbit as OrbitIcon,
  Plus,
  RefreshCw,
  Unlink,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  Badge,
  Button,
  Card,
  Dialog,
  Drawer,
  EmptyState,
  Input,
  Select,
  Skeleton,
  useToast,
} from "../../design";
import { useOrion, useOrionQuery } from "../../lib/orion";

export type HealthOrbitStatus = "healthy" | "watch" | "alert";
export type HerdSortField =
  | "earTagNumber"
  | "name"
  | "groupName"
  | "species"
  | "wearable"
  | "lastMilking"
  | "status";
export type SortDirection = "asc" | "desc";

export interface EnrichedAnimal extends Animal {
  wearable: ActiveWearable | null;
  healthStatus: HealthOrbitStatus;
  latestAlert: Observation | null;
  lastMilkingKg: number | null;
  lastMilkingTs: string | null;
}

const WEARABLE_LABELS: Record<string, string> = {
  collar: "Collar",
  bolus: "Bolus",
  ear_tag_sensor: "Ear tag sensor",
};

export function formatWearableKind(kind: string | null | undefined): string {
  if (!kind) return "No sensor";
  return WEARABLE_LABELS[kind] ?? kind.replace(/_/g, " ");
}

export function articleForKind(label: string): "a" | "an" {
  return /^[aeiou]/i.test(label.trim()) ? "an" : "a";
}

export function formatWearableWithArticle(kind: string | null | undefined): string {
  const label = formatWearableKind(kind).toLowerCase();
  return `${articleForKind(label)} ${label}`;
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "Just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function computeAnimalHealthStatus(
  animal: Animal & { wearable: ActiveWearable | null },
  alerts: Observation[],
): { healthStatus: HealthOrbitStatus; latestAlert: Observation | null } {
  const animalAlerts = alerts.filter((a) => a.animalId === animal.id);
  const latestAlert = animalAlerts[0] ?? null;

  if (latestAlert) {
    if (latestAlert.kind === "calving_alert" || latestAlert.kind === "health_event") {
      return { healthStatus: "alert", latestAlert };
    }
    if (latestAlert.kind === "heat_alert") {
      return { healthStatus: "watch", latestAlert };
    }
  }

  if (
    animal.wearable?.batteryPct !== null &&
    animal.wearable?.batteryPct !== undefined &&
    animal.wearable.batteryPct < 25
  ) {
    return { healthStatus: "watch", latestAlert };
  }

  return { healthStatus: "healthy", latestAlert: null };
}

export function sortAnimals(
  rows: EnrichedAnimal[],
  field: HerdSortField,
  direction: SortDirection,
): EnrichedAnimal[] {
  const mult = direction === "asc" ? 1 : -1;
  const statusRank: Record<HealthOrbitStatus, number> = {
    alert: 3,
    watch: 2,
    healthy: 1,
  };

  return [...rows].sort((a, b) => {
    switch (field) {
      case "earTagNumber": {
        const av = a.earTagNumber ?? a.nationalId ?? "";
        const bv = b.earTagNumber ?? b.nationalId ?? "";
        return av.localeCompare(bv, undefined, { numeric: true }) * mult;
      }
      case "name": {
        const av = a.name ?? "";
        const bv = b.name ?? "";
        return av.localeCompare(bv) * mult;
      }
      case "groupName": {
        const av = a.groupName ?? "";
        const bv = b.groupName ?? "";
        return av.localeCompare(bv) * mult;
      }
      case "species":
        return a.species.localeCompare(b.species) * mult;
      case "wearable": {
        const av = a.wearable?.kind ?? "zzz";
        const bv = b.wearable?.kind ?? "zzz";
        return av.localeCompare(bv) * mult;
      }
      case "lastMilking": {
        const av = a.lastMilkingKg ?? -1;
        const bv = b.lastMilkingKg ?? -1;
        return (av - bv) * mult;
      }
      case "status": {
        const diff = statusRank[a.healthStatus] - statusRank[b.healthStatus];
        if (diff !== 0) return diff * mult;
        return (a.name ?? "").localeCompare(b.name ?? "");
      }
      default:
        return 0;
    }
  });
}

interface SparklineCardProps {
  title: string;
  unit: string;
  observations: Observation[];
  color: string;
  testId: string;
}

function SparklineCard({ title, unit, observations, color, testId }: SparklineCardProps) {
  const sorted = useMemo(
    () =>
      [...observations]
        .filter((o) => typeof o.valueNum === "number")
        .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
        .slice(-14),
    [observations],
  );

  const latest = sorted[sorted.length - 1];
  const values = sorted.map((s) => s.valueNum as number);
  const minVal = values.length > 0 ? Math.min(...values) : 0;
  const maxVal = values.length > 0 ? Math.max(...values) : 1;
  const span = maxVal - minVal || 1;

  const width = 200;
  const height = 44;
  const pad = 4;

  const points = values
    .map((v, idx) => {
      const x =
        values.length === 1 ? width / 2 : pad + (idx / (values.length - 1)) * (width - pad * 2);
      const y = height - pad - ((v - minVal) / span) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <div
      data-testid={testId}
      style={{
        padding: "var(--space-3)",
        borderRadius: "var(--radius-md)",
        backgroundColor: "var(--bg-elevated)",
        border: "1px solid var(--border-subtle)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
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
          {title}
        </span>
        <span
          className="tabular-nums"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-sm)",
            fontWeight: 700,
            color: "var(--text-primary)",
          }}
        >
          {latest?.valueNum !== undefined && latest?.valueNum !== null
            ? `${latest.valueNum} ${unit}`
            : "No readings"}
        </span>
      </div>

      {values.length > 0 ? (
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${title} trend chart`}
          style={{ display: "block", overflow: "visible" }}
        >
          <polyline
            fill="none"
            stroke={color}
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={points}
          />
          {values.map((v, idx) => {
            const x =
              values.length === 1
                ? width / 2
                : pad + (idx / (values.length - 1)) * (width - pad * 2);
            const y = height - pad - ((v - minVal) / span) * (height - pad * 2);
            return (
              <circle
                key={`${sorted[idx]?.id ?? idx}`}
                cx={x}
                cy={y}
                r={idx === values.length - 1 ? 3.5 : 2}
                fill={idx === values.length - 1 ? color : "var(--bg-surface)"}
                stroke={color}
                strokeWidth="1.5"
              />
            );
          })}
        </svg>
      ) : (
        <div
          style={{
            blockSize: `${height}px`,
            display: "flex",
            alignItems: "center",
            fontSize: "var(--text-xs)",
            color: "var(--text-muted)",
          }}
        >
          Waiting for sensor or robot observations
        </div>
      )}
    </div>
  );
}

interface HerdOrbitCanvasProps {
  animals: EnrichedAnimal[];
  selectedAnimalId: string | null;
  onSelectAnimal: (animalId: string) => void;
}

function HerdOrbitCanvas({ animals, selectedAnimalId, onSelectAnimal }: HerdOrbitCanvasProps) {
  const cx = 230;
  const cy = 230;
  const ringRadii: Record<HealthOrbitStatus, number> = {
    healthy: 78,
    watch: 132,
    alert: 184,
  };

  const groupedByRing = useMemo(() => {
    const healthy = animals.filter((a) => a.healthStatus === "healthy");
    const watch = animals.filter((a) => a.healthStatus === "watch");
    const alert = animals.filter((a) => a.healthStatus === "alert");
    return { healthy, watch, alert };
  }, [animals]);

  const toneForStatus = (s: HealthOrbitStatus): string => {
    if (s === "alert") return "var(--status-danger)";
    if (s === "watch") return "var(--status-warn)";
    return "var(--status-ok)";
  };

  return (
    <div
      data-testid="herd-orbit-view"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(22rem, 100%), 1fr))",
        gap: "var(--space-6)",
        alignItems: "start",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "var(--space-3)",
          backgroundColor: "var(--bg-elevated)",
          borderRadius: "var(--radius-lg)",
          border: "1px solid var(--border-subtle)",
        }}
      >
        <svg
          width={360}
          height={360}
          viewBox="0 0 460 460"
          role="img"
          aria-label="Herd status orbit rings: inner ring healthy, middle ring watch, outer ring alert"
          style={{ maxInlineSize: "100%", blockSize: "auto", display: "block" }}
        >
          <defs>
            <radialGradient id="herd-orbit-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--accent-primary)" stopOpacity="0.16" />
              <stop offset="70%" stopColor="var(--accent-primary)" stopOpacity="0.04" />
              <stop offset="100%" stopColor="var(--accent-primary)" stopOpacity="0" />
            </radialGradient>
          </defs>

          <circle cx={cx} cy={cy} r={210} fill="url(#herd-orbit-glow)" />

          <line
            x1={cx - 198}
            y1={cy}
            x2={cx + 198}
            y2={cy}
            stroke="var(--border-subtle)"
            strokeWidth="1"
            strokeDasharray="4 6"
          />
          <line
            x1={cx}
            y1={cy - 198}
            x2={cx}
            y2={cy + 198}
            stroke="var(--border-subtle)"
            strokeWidth="1"
            strokeDasharray="4 6"
          />

          <circle
            cx={cx}
            cy={cy}
            r={ringRadii.alert}
            fill="none"
            stroke="var(--status-danger-border)"
            strokeWidth="2"
            strokeDasharray="6 5"
          />
          <circle
            cx={cx}
            cy={cy}
            r={ringRadii.watch}
            fill="none"
            stroke="var(--status-warn-border)"
            strokeWidth="2"
          />
          <circle
            cx={cx}
            cy={cy}
            r={ringRadii.healthy}
            fill="none"
            stroke="var(--status-ok-border)"
            strokeWidth="2.25"
          />

          <circle
            cx={cx}
            cy={cy}
            r={40}
            fill="var(--orbit-core-bg)"
            stroke="var(--accent-primary)"
            strokeWidth="2.25"
          />
          <text
            x={cx}
            y={cy - 4}
            textAnchor="middle"
            fill="var(--text-primary)"
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "13px",
              fontWeight: 750,
              letterSpacing: "0.05em",
            }}
          >
            HERD
          </text>
          <text
            x={cx}
            y={cy + 14}
            textAnchor="middle"
            fill="var(--text-secondary)"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "11px",
              fontWeight: 700,
            }}
          >
            {animals.length} head
          </text>

          {(["healthy", "watch", "alert"] as const).map((ringKey) => {
            const list = groupedByRing[ringKey];
            const radius = ringRadii[ringKey];
            const startOffset = ringKey === "healthy" ? -90 : ringKey === "watch" ? -45 : -20;

            return list.map((animal, idx) => {
              const angleDeg = startOffset + (idx / Math.max(1, list.length)) * 360;
              const rad = (angleDeg * Math.PI) / 180;
              const sx = cx + radius * Math.cos(rad);
              const sy = cy + radius * Math.sin(rad);
              const isSelected = animal.id === selectedAnimalId;
              const color = toneForStatus(animal.healthStatus);
              const label = animal.name ?? animal.earTagNumber ?? "Animal";

              return (
                <a
                  key={animal.id}
                  href={`#animal-${animal.id}`}
                  aria-label={`Inspect ${label} (${animal.earTagNumber ?? animal.species}, ${animal.healthStatus})`}
                  data-testid={`herd-orbit-dot-${animal.earTagNumber ?? animal.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onSelectAnimal(animal.id);
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <title>{`${label} (${animal.earTagNumber ?? animal.nationalId ?? animal.species}) — ${animal.groupName ?? "Ungrouped"} — ${animal.healthStatus.toUpperCase()}`}</title>
                  <circle cx={sx} cy={sy} r={18} fill="transparent" />
                  {isSelected && (
                    <circle
                      cx={sx}
                      cy={sy}
                      r={14}
                      fill="none"
                      stroke="var(--accent-primary)"
                      strokeWidth="2.5"
                    />
                  )}
                  <circle
                    cx={sx}
                    cy={sy}
                    r={ringKey === "healthy" ? 8.5 : 10.5}
                    fill={isSelected ? color : "var(--bg-surface)"}
                    stroke={color}
                    strokeWidth="2.5"
                  />
                  <circle cx={sx} cy={sy} r={3.5} fill={isSelected ? "var(--bg-surface)" : color} />
                  {(ringKey !== "healthy" || isSelected || list.length <= 8) && (
                    <text
                      x={sx}
                      y={sy - 14}
                      textAnchor="middle"
                      fill="var(--text-primary)"
                      style={{
                        fontFamily: "var(--font-sans)",
                        fontSize: "10.5px",
                        fontWeight: 700,
                      }}
                    >
                      {animal.name ?? animal.earTagNumber}
                    </text>
                  )}
                </a>
              );
            });
          })}
        </svg>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))",
            gap: "var(--space-3)",
          }}
        >
          <div
            style={{
              padding: "var(--space-3) var(--space-4)",
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--bg-elevated)",
              border: "1px solid var(--border-subtle)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-1)",
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
                className="tabular-nums"
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "var(--text-h2)",
                  fontWeight: 750,
                  lineHeight: 1,
                }}
              >
                {groupedByRing.alert.length}
              </span>
              <Badge variant="danger">Outer ring · Alert</Badge>
            </div>
            <p
              style={{
                margin: "var(--space-1) 0 0 0",
                fontSize: "var(--text-xs)",
                color: "var(--text-secondary)",
              }}
            >
              Calving or health temperature alerts needing an immediate check.
            </p>
          </div>

          <div
            style={{
              padding: "var(--space-3) var(--space-4)",
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--bg-elevated)",
              border: "1px solid var(--border-subtle)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-1)",
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
                className="tabular-nums"
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "var(--text-h2)",
                  fontWeight: 750,
                  lineHeight: 1,
                }}
              >
                {groupedByRing.watch.length}
              </span>
              <Badge variant="warn">Middle ring · Watch</Badge>
            </div>
            <p
              style={{
                margin: "var(--space-1) 0 0 0",
                fontSize: "var(--text-xs)",
                color: "var(--text-secondary)",
              }}
            >
              Standing heat window or low wearable battery (&lt;25%).
            </p>
          </div>

          <div
            style={{
              padding: "var(--space-3) var(--space-4)",
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--bg-elevated)",
              border: "1px solid var(--border-subtle)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-1)",
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
                className="tabular-nums"
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "var(--text-h2)",
                  fontWeight: 750,
                  lineHeight: 1,
                }}
              >
                {groupedByRing.healthy.length}
              </span>
              <Badge variant="ok">Inner ring · Healthy</Badge>
            </div>
            <p
              style={{
                margin: "var(--space-1) 0 0 0",
                fontSize: "var(--text-xs)",
                color: "var(--text-secondary)",
              }}
            >
              Steady milking, rumination, and activity inside normal range.
            </p>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-3)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <h3
              style={{
                margin: 0,
                fontFamily: "var(--font-display)",
                fontSize: "var(--text-lg)",
                fontWeight: 700,
              }}
            >
              Animals on the orbit ({animals.length})
            </h3>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
              Click any animal dot or card to open its drawer
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(13.5rem, 1fr))",
              gap: "var(--space-2)",
              maxBlockSize: "20rem",
              overflowY: "auto",
              paddingRight: "var(--space-1)",
            }}
          >
            {animals.map((animal) => {
              const badgeVariant =
                animal.healthStatus === "alert"
                  ? "danger"
                  : animal.healthStatus === "watch"
                    ? "warn"
                    : "ok";
              const statusLabel =
                animal.healthStatus === "alert"
                  ? "Alert"
                  : animal.healthStatus === "watch"
                    ? "Watch"
                    : "Healthy";

              return (
                <button
                  key={animal.id}
                  type="button"
                  data-testid={`herd-orbit-card-${animal.earTagNumber ?? animal.id}`}
                  onClick={() => onSelectAnimal(animal.id)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: "var(--space-1)",
                    padding: "var(--space-3)",
                    borderRadius: "var(--radius-md)",
                    backgroundColor:
                      selectedAnimalId === animal.id
                        ? "var(--accent-primary-subtle)"
                        : "var(--bg-surface)",
                    border: `1px solid ${
                      selectedAnimalId === animal.id
                        ? "var(--accent-primary-border)"
                        : "var(--border-subtle)"
                    }`,
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "var(--font-sans)",
                    color: "var(--text-primary)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      inlineSize: "100%",
                      gap: "var(--space-2)",
                    }}
                  >
                    <span style={{ fontWeight: 700, fontSize: "var(--text-sm)" }}>
                      {animal.name ?? "Unnamed"}
                    </span>
                    <Badge variant={badgeVariant}>{statusLabel}</Badge>
                  </div>
                  <div
                    className="tabular-nums"
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-xs)",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {animal.earTagNumber ?? animal.nationalId ?? animal.species} ·{" "}
                    {animal.groupName ?? "Ungrouped"}
                  </div>
                  <div
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--text-muted)",
                    }}
                  >
                    {animal.wearable
                      ? `${formatWearableKind(animal.wearable.kind)}${
                          animal.wearable.vendor ? ` (${animal.wearable.vendor})` : ""
                        }`
                      : "No wearable sensor"}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

interface AttachSensorDialogProps {
  open: boolean;
  onClose: () => void;
  animal: Animal;
  currentWearable: ActiveWearable | null;
  wearableDevices: DeviceListItem[];
  allAnimals: EnrichedAnimal[];
  onBound: () => Promise<void>;
}

function AttachSensorDialog({
  open,
  onClose,
  animal,
  currentWearable,
  wearableDevices,
  allAnimals,
  onBound,
}: AttachSensorDialogProps) {
  const { client } = useOrion();
  const { pushToast } = useToast();
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const animalById = useMemo(() => new Map(allAnimals.map((a) => [a.id, a])), [allAnimals]);

  const candidateDevices = useMemo(() => {
    return wearableDevices.filter((d) => d.id !== currentWearable?.deviceId);
  }, [wearableDevices, currentWearable]);

  const effectiveDeviceId = selectedDeviceId || candidateDevices[0]?.id || "";
  const chosenDevice = candidateDevices.find((d) => d.id === effectiveDeviceId) ?? null;
  const previousHolder =
    chosenDevice?.boundAnimalId && chosenDevice.boundAnimalId !== animal.id
      ? (animalById.get(chosenDevice.boundAnimalId) ?? null)
      : null;

  const handleConfirm = async (e: FormEvent) => {
    e.preventDefault();
    if (!client || !effectiveDeviceId) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      if (currentWearable && currentWearable.deviceId !== effectiveDeviceId) {
        await client.mutate("bindings.clear", { deviceId: currentWearable.deviceId });
      }
      await client.mutate("bindings.set", {
        deviceId: effectiveDeviceId,
        animalId: animal.id,
      });
      pushToast({
        title: currentWearable ? "Wearable sensor replaced" : "Wearable sensor attached",
        description: `${formatWearableKind(chosenDevice?.kind)} ${chosenDevice?.serial ?? ""} is now attached to ${animal.name ?? animal.earTagNumber ?? "this animal"}.`,
        tone: "ok",
      });
      await onBound();
      onClose();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        currentWearable
          ? `Replace wearable sensor on ${animal.name ?? animal.earTagNumber ?? "animal"}`
          : `Attach wearable sensor to ${animal.name ?? animal.earTagNumber ?? "animal"}`
      }
      description="Each animal wears one collar OR one bolus OR one ear tag sensor at a time — never several together."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} data-testid="herd-attach-sensor-cancel">
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="herd-attach-sensor-form"
            loading={submitting}
            disabled={!effectiveDeviceId}
            data-testid="herd-attach-sensor-submit"
          >
            {currentWearable ? "Replace current sensor" : "Attach sensor"}
          </Button>
        </>
      }
    >
      <form
        id="herd-attach-sensor-form"
        onSubmit={handleConfirm}
        data-testid="herd-attach-sensor-dialog"
        style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
      >
        <div
          style={{
            padding: "var(--space-3) var(--space-4)",
            borderRadius: "var(--radius-md)",
            backgroundColor: "var(--bg-elevated)",
            border: "1px solid var(--border-subtle)",
            fontSize: "var(--text-sm)",
            color: "var(--text-secondary)",
          }}
        >
          <strong style={{ color: "var(--text-primary)" }}>One wearable sensor rule:</strong>{" "}
          Farmers put a collar OR a bolus OR an ear tag sensor on an animal, never more than one at
          the same time.
        </div>

        {currentWearable && (
          <div
            data-testid="herd-attach-replace-notice"
            style={{
              padding: "var(--space-3) var(--space-4)",
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--status-warn-bg)",
              border: "1px solid var(--status-warn-border)",
              fontSize: "var(--text-sm)",
              color: "var(--text-primary)",
            }}
          >
            <strong>{animal.name ?? animal.earTagNumber}</strong> currently wears{" "}
            {articleForKind(formatWearableKind(currentWearable.kind))}{" "}
            <strong>{formatWearableKind(currentWearable.kind).toLowerCase()}</strong>
            {currentWearable.vendor ? ` (${currentWearable.vendor})` : ""}. Attaching a new sensor
            will automatically remove the existing{" "}
            {formatWearableKind(currentWearable.kind).toLowerCase()} first.
          </div>
        )}

        <Select
          label="Choose collar, bolus, or ear tag sensor"
          data-testid="herd-attach-sensor-select"
          value={effectiveDeviceId}
          onChange={(e) => setSelectedDeviceId(e.target.value)}
          options={
            candidateDevices.length > 0
              ? candidateDevices.map((d) => {
                  const holder = d.boundAnimalId ? animalById.get(d.boundAnimalId) : null;
                  const holderText = holder
                    ? ` — currently on ${holder.name ?? holder.earTagNumber}`
                    : " — spare / unassigned";
                  return {
                    value: d.id,
                    label: `${formatWearableKind(d.kind)} · ${d.vendor ?? "Sensor"} ${d.serial ?? ""}${holderText}`,
                  };
                })
              : [{ value: "", label: "No wearable sensors added yet" }]
          }
        />

        {previousHolder && (
          <div
            style={{
              padding: "var(--space-3) var(--space-4)",
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--bg-elevated)",
              border: "1px solid var(--border-subtle)",
              fontSize: "var(--text-xs)",
              color: "var(--text-secondary)",
            }}
          >
            Moving this sensor will unbind it from{" "}
            <strong style={{ color: "var(--text-primary)" }}>
              {previousHolder.name ?? previousHolder.earTagNumber}
            </strong>{" "}
            and attach it to{" "}
            <strong style={{ color: "var(--text-primary)" }}>
              {animal.name ?? animal.earTagNumber}
            </strong>
            .
          </div>
        )}

        {errorMessage && (
          <p className="orbit-field__error" role="alert">
            {errorMessage}
          </p>
        )}
      </form>
    </Dialog>
  );
}

interface AnimalFormDialogProps {
  open: boolean;
  onClose: () => void;
  editingAnimal: Animal | null;
  onSaved: (savedId: string) => Promise<void>;
}

function AnimalFormDialog({ open, onClose, editingAnimal, onSaved }: AnimalFormDialogProps) {
  const { client } = useOrion();
  const { pushToast } = useToast();

  const [species, setSpecies] = useState<Species>(editingAnimal?.species ?? "cattle");
  const [name, setName] = useState(editingAnimal?.name ?? "");
  const [earTagNumber, setEarTagNumber] = useState(editingAnimal?.earTagNumber ?? "");
  const [nationalId, setNationalId] = useState(editingAnimal?.nationalId ?? "");
  const [breed, setBreed] = useState(editingAnimal?.breed ?? "");
  const [sex, setSex] = useState<AnimalSex>(editingAnimal?.sex ?? "female");
  const [birthDate, setBirthDate] = useState(editingAnimal?.birthDate ?? "");
  const [groupName, setGroupName] = useState(editingAnimal?.groupName ?? "Milking");
  const [status, setStatus] = useState<AnimalStatus>(editingAnimal?.status ?? "active");
  const [notes, setNotes] = useState(editingAnimal?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!client) return;
    if (!name.trim() && !earTagNumber.trim()) {
      setError("Please enter an animal name or ear tag number.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const payload: AnimalInput = {
        ...(editingAnimal ? { id: editingAnimal.id } : {}),
        species,
        name: name.trim() || null,
        earTagNumber: earTagNumber.trim() || null,
        nationalId: nationalId.trim() || null,
        breed: breed.trim() || null,
        sex,
        birthDate: birthDate.trim() || null,
        groupName: groupName.trim() || null,
        status,
        notes: notes.trim() || null,
      };
      const res = await client.mutate("animals.upsert", { animal: payload });
      const savedId = res.ids[0] ?? editingAnimal?.id ?? "";
      pushToast({
        title: editingAnimal ? "Animal updated" : "Animal added",
        description: `${name.trim() || earTagNumber.trim()} saved on this farm PC.`,
        tone: "ok",
      });
      await onSaved(savedId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        editingAnimal
          ? `Edit ${editingAnimal.name ?? editingAnimal.earTagNumber ?? "animal"}`
          : "Add cow or horse"
      }
      description="Enter the ear tag, name, group, and breed. Every change is saved locally and can be undone."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} data-testid="animal-form-cancel">
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="herd-animal-form"
            loading={saving}
            data-testid="animal-form-submit"
          >
            {editingAnimal ? "Save changes" : "Add animal"}
          </Button>
        </>
      }
    >
      <form
        id="herd-animal-form"
        onSubmit={handleSubmit}
        data-testid="animal-form-dialog"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: "var(--space-4)",
        }}
      >
        <Select
          label="Species"
          data-testid="animal-form-species"
          value={species}
          onChange={(e) => {
            const nextSpecies = e.target.value as Species;
            setSpecies(nextSpecies);
            if (nextSpecies === "horse" && groupName === "Milking") {
              setGroupName("Stable");
            }
          }}
          options={[
            { value: "cattle", label: "Cattle (dairy or beef)" },
            { value: "horse", label: "Horse" },
          ]}
        />
        <Select
          label="Status"
          data-testid="animal-form-status"
          value={status}
          onChange={(e) => setStatus(e.target.value as AnimalStatus)}
          options={[
            { value: "active", label: "Active on farm" },
            { value: "sold", label: "Sold" },
            { value: "dead", label: "Deceased" },
          ]}
        />

        <Input
          label="Name"
          data-testid="animal-form-name"
          placeholder={species === "horse" ? "e.g. Storm" : "e.g. Bella"}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          label="Ear tag number"
          data-testid="animal-form-eartag"
          placeholder={species === "horse" ? "Optional for horses" : "e.g. 1017"}
          value={earTagNumber}
          onChange={(e) => setEarTagNumber(e.target.value)}
        />

        <Input
          label="Group / Barn area"
          data-testid="animal-form-group"
          placeholder="Milking, Dry, Heifers, Pasture, Stable"
          value={groupName}
          onChange={(e) => setGroupName(e.target.value)}
        />
        <Input
          label="Breed"
          data-testid="animal-form-breed"
          placeholder={species === "horse" ? "e.g. Warmblood, Fjord" : "e.g. Holstein, Angus"}
          value={breed}
          onChange={(e) => setBreed(e.target.value)}
        />

        <Select
          label="Sex"
          data-testid="animal-form-sex"
          value={sex}
          onChange={(e) => setSex(e.target.value as AnimalSex)}
          options={[
            { value: "female", label: "Female (Cow / Mare)" },
            { value: "male", label: "Male (Bull / Stallion)" },
            { value: "castrated", label: "Steer / Gelding" },
            { value: "unknown", label: "Unknown" },
          ]}
        />
        <Input
          label="Birth date"
          type="date"
          data-testid="animal-form-birthdate"
          value={birthDate}
          onChange={(e) => setBirthDate(e.target.value)}
        />

        <div style={{ gridColumn: "1 / -1" }}>
          <Input
            label="National ID / UELN"
            data-testid="animal-form-national-id"
            placeholder="Official animal ID or passport number"
            value={nationalId}
            onChange={(e) => setNationalId(e.target.value)}
          />
        </div>

        <div style={{ gridColumn: "1 / -1" }}>
          <Input
            label="Notes"
            data-testid="animal-form-notes"
            placeholder="Calving notes, hoof care, or feeding instructions"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        {error && (
          <div style={{ gridColumn: "1 / -1" }}>
            <p className="orbit-field__error" role="alert">
              {error}
            </p>
          </div>
        )}
      </form>
    </Dialog>
  );
}

export interface HerdPageProps {
  initialViewMode?: "orbit" | "table";
}

export function HerdPage({ initialViewMode = "orbit" }: HerdPageProps = {}) {
  const navigate = useNavigate();
  const { client } = useOrion();
  const { pushToast } = useToast();

  const [viewMode, setViewMode] = useState<"orbit" | "table">(initialViewMode);
  const [speciesFilter, setSpeciesFilter] = useState<string>("all");
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [searchQuery, setSearchQuery] = useState<string>("");

  const [sortField, setSortField] = useState<HerdSortField>("earTagNumber");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  const [selectedAnimalId, setSelectedAnimalId] = useState<string | null>(null);
  const [animalFormOpen, setAnimalFormOpen] = useState(false);
  const [editingAnimal, setEditingAnimal] = useState<Animal | null>(null);
  const [attachDialogOpen, setAttachDialogOpen] = useState(false);

  const {
    data: animalsData,
    loading: animalsLoading,
    error: animalsError,
    refetch: refetchAnimals,
  } = useOrionQuery(
    "animals.list",
    { limit: 500 },
    { refetchTables: ["animals", "device_bindings", "devices"] },
  );

  const { data: alertsData, refetch: refetchAlerts } = useOrionQuery(
    "observations.recent",
    { alertsOnly: true, limit: 100 },
    { refetchTables: ["observations"] },
  );

  const { data: milkingsData, refetch: refetchMilkings } = useOrionQuery(
    "observations.recent",
    { kind: "milking", limit: 300 },
    { refetchTables: ["observations"] },
  );

  const { data: devicesData, refetch: refetchDevices } = useOrionQuery(
    "devices.list",
    {},
    { refetchTables: ["devices", "device_bindings"] },
  );

  const {
    data: selectedDetail,
    loading: detailLoading,
    refetch: refetchDetail,
  } = useOrionQuery(
    "animals.get",
    { id: selectedAnimalId ?? "" },
    {
      enabled: Boolean(selectedAnimalId),
      refetchTables: ["animals", "device_bindings", "devices", "observations"],
    },
  );

  const enrichedAnimals = useMemo<EnrichedAnimal[]>(() => {
    const raw = animalsData?.rows ?? [];
    const alerts = alertsData?.rows ?? [];
    const milkings = milkingsData?.rows ?? [];

    const latestMilkingByAnimal = new Map<string, Observation>();
    for (const m of milkings) {
      if (!m.animalId) continue;
      if (!latestMilkingByAnimal.has(m.animalId)) {
        latestMilkingByAnimal.set(m.animalId, m);
      }
    }

    return raw.map((a) => {
      const { healthStatus, latestAlert } = computeAnimalHealthStatus(a, alerts);
      const lastMilk = latestMilkingByAnimal.get(a.id) ?? null;
      return {
        ...a,
        healthStatus,
        latestAlert,
        lastMilkingKg: lastMilk?.valueNum ?? null,
        lastMilkingTs: lastMilk?.ts ?? null,
      };
    });
  }, [animalsData, alertsData, milkingsData]);

  const availableGroups = useMemo(() => {
    const set = new Set<string>();
    for (const a of enrichedAnimals) {
      if (a.groupName) set.add(a.groupName);
    }
    return Array.from(set).sort();
  }, [enrichedAnimals]);

  const filteredAnimals = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return enrichedAnimals.filter((a) => {
      if (speciesFilter !== "all" && a.species !== speciesFilter) return false;
      if (groupFilter !== "all" && (a.groupName ?? "") !== groupFilter) return false;
      if (statusFilter !== "all" && a.status !== statusFilter) return false;
      if (q) {
        const hay = [
          a.name ?? "",
          a.earTagNumber ?? "",
          a.nationalId ?? "",
          a.breed ?? "",
          a.groupName ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [enrichedAnimals, speciesFilter, groupFilter, statusFilter, searchQuery]);

  const sortedAnimals = useMemo(
    () => sortAnimals(filteredAnimals, sortField, sortDirection),
    [filteredAnimals, sortField, sortDirection],
  );

  const wearableDevices = useMemo(() => {
    return (devicesData?.rows ?? []).filter(
      (d) => d.kind === "collar" || d.kind === "bolus" || d.kind === "ear_tag_sensor",
    );
  }, [devicesData]);

  const handleSort = (field: HerdSortField) => {
    if (sortField === field) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  const handleUnbindWearable = async (deviceId: string, animalLabel: string) => {
    if (!client) return;
    try {
      await client.mutate("bindings.clear", { deviceId });
      pushToast({
        title: "Sensor removed",
        description: `Removed wearable sensor from ${animalLabel}.`,
        tone: "ok",
      });
      await Promise.all([refetchAnimals(), refetchDevices(), refetchDetail()]);
    } catch (err) {
      pushToast({
        title: "Could not remove sensor",
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    }
  };

  const selectedAnimal =
    selectedDetail?.animal ?? enrichedAnimals.find((a) => a.id === selectedAnimalId) ?? null;

  const selectedWearable =
    selectedDetail?.wearable ??
    enrichedAnimals.find((a) => a.id === selectedAnimalId)?.wearable ??
    null;

  const detailObservations = selectedDetail?.recentObservations ?? [];

  const renderSortIcon = (field: HerdSortField) => {
    if (sortField !== field) return <ArrowUpDown size={14} aria-hidden="true" />;
    return sortDirection === "asc" ? (
      <ArrowUp size={14} aria-hidden="true" />
    ) : (
      <ArrowDown size={14} aria-hidden="true" />
    );
  };

  return (
    <div className="orbit-container" data-testid="herd-page">
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "var(--space-4)",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
            <h1
              style={{
                margin: 0,
                fontFamily: "var(--font-display)",
                fontSize: "var(--text-h1)",
                fontWeight: 750,
                lineHeight: "var(--leading-tight)",
                letterSpacing: "var(--tracking-display)",
              }}
            >
              Cows & Horses
            </h1>
            <Badge variant="neutral" className="tabular-nums">
              {filteredAnimals.length} shown
            </Badge>
          </div>
          <p
            style={{
              margin: "var(--space-2) 0 0 0",
              color: "var(--text-secondary)",
              fontSize: "var(--text-base)",
              maxInlineSize: "68ch",
            }}
          >
            Inspect your herd on the status orbit or switch to the sortable herd table.
          </p>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "var(--space-3)",
          }}
        >
          <div className="orbit-tablist" role="tablist" aria-label="Herd view mode">
            <button
              type="button"
              role="tab"
              className="orbit-tab"
              aria-selected={viewMode === "orbit"}
              data-testid="herd-view-orbit-btn"
              onClick={() => setViewMode("orbit")}
              style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
            >
              <OrbitIcon size={16} />
              Orbit Rings
            </button>
            <button
              type="button"
              role="tab"
              className="orbit-tab"
              aria-selected={viewMode === "table"}
              data-testid="herd-view-table-btn"
              onClick={() => setViewMode("table")}
              style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}
            >
              <LayoutGrid size={16} />
              Sortable Table
            </button>
          </div>

          <Button
            variant="primary"
            size="md"
            icon={<Plus size={18} />}
            data-testid="herd-add-animal-btn"
            onClick={() => {
              setEditingAnimal(null);
              setAnimalFormOpen(true);
            }}
          >
            Add cow or horse
          </Button>
        </div>
      </header>

      <Card variant="default">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
            gap: "var(--space-3)",
            alignItems: "end",
          }}
        >
          <Input
            label="Search by ear tag, name, or ID"
            data-testid="herd-search-input"
            placeholder="Search name or ear tag"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          <Select
            label="Species"
            data-testid="herd-filter-species"
            value={speciesFilter}
            onChange={(e) => setSpeciesFilter(e.target.value)}
            options={[
              { value: "all", label: "All species" },
              { value: "cattle", label: "Cattle only" },
              { value: "horse", label: "Horses only" },
            ]}
          />

          <Select
            label="Barn group"
            data-testid="herd-filter-group"
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            options={[
              { value: "all", label: "All groups" },
              ...availableGroups.map((g) => ({ value: g, label: g })),
            ]}
          />

          <Select
            label="Status"
            data-testid="herd-filter-status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={[
              { value: "active", label: "Active on farm" },
              { value: "all", label: "All statuses" },
              { value: "sold", label: "Sold" },
              { value: "dead", label: "Deceased" },
            ]}
          />
        </div>
      </Card>

      {animalsError ? (
        <Card
          title="Could not load herd records"
          subtitle="Check that Orion is running on this farm PC"
          data-testid="herd-error-state"
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "var(--space-4)",
            }}
          >
            <p style={{ margin: 0, color: "var(--status-danger)", fontSize: "var(--text-sm)" }}>
              {animalsError.message}
            </p>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw size={15} />}
              onClick={() => void refetchAnimals()}
              data-testid="herd-retry-btn"
            >
              Try again
            </Button>
          </div>
        </Card>
      ) : animalsLoading && !animalsData ? (
        <Card title="Loading herd records…" data-testid="herd-loading-state">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            <Skeleton height="3rem" />
            <Skeleton height="3rem" />
            <Skeleton height="3rem" />
            <Skeleton height="3rem" />
          </div>
        </Card>
      ) : sortedAnimals.length === 0 ? (
        <EmptyState
          data-testid="herd-empty-state"
          title="No cows or horses match these filters"
          description="Clear the search filter or add a new cow or horse to your herd."
          action={
            <div style={{ display: "flex", gap: "var(--space-3)" }}>
              {(searchQuery || speciesFilter !== "all" || groupFilter !== "all") && (
                <Button
                  variant="secondary"
                  data-testid="herd-clear-filters-btn"
                  onClick={() => {
                    setSearchQuery("");
                    setSpeciesFilter("all");
                    setGroupFilter("all");
                    setStatusFilter("active");
                  }}
                >
                  Reset filters
                </Button>
              )}
              <Button
                variant="primary"
                icon={<Plus size={16} />}
                onClick={() => {
                  setEditingAnimal(null);
                  setAnimalFormOpen(true);
                }}
              >
                Add cow or horse
              </Button>
            </div>
          }
        />
      ) : viewMode === "orbit" ? (
        <Card
          title="Herd Status Orbit"
          subtitle="Inner ring: healthy · Middle ring: watch (heat or low battery) · Outer ring: urgent calving or health alert"
        >
          <HerdOrbitCanvas
            animals={sortedAnimals}
            selectedAnimalId={selectedAnimalId}
            onSelectAnimal={(id) => setSelectedAnimalId(id)}
          />
        </Card>
      ) : (
        <Card
          title="Sortable Herd List"
          subtitle="Click any column header to sort, or click a row to inspect the animal and its wearable sensor"
        >
          <div style={{ overflowX: "auto" }}>
            <table
              data-testid="herd-table"
              style={{
                inlineSize: "100%",
                borderCollapse: "collapse",
                fontSize: "var(--text-sm)",
                textAlign: "left",
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBlockEnd: "1px solid var(--border-strong)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {(
                    [
                      { key: "earTagNumber", label: "Ear tag / ID" },
                      { key: "name", label: "Name" },
                      { key: "groupName", label: "Group" },
                      { key: "species", label: "Species" },
                      { key: "wearable", label: "Wearable sensor" },
                      { key: "lastMilking", label: "Last milking" },
                      { key: "status", label: "Status" },
                    ] as const
                  ).map((col) => (
                    <th
                      key={col.key}
                      scope="col"
                      aria-sort={
                        sortField === col.key
                          ? sortDirection === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                      style={{ padding: "var(--space-3)" }}
                    >
                      <button
                        type="button"
                        data-testid={`herd-sort-${col.key}`}
                        onClick={() => handleSort(col.key)}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "var(--space-1)",
                          background: "none",
                          border: "none",
                          padding: "var(--space-1) var(--space-2)",
                          marginInlineStart: "calc(-1 * var(--space-2))",
                          borderRadius: "var(--radius-sm)",
                          fontFamily: "var(--font-sans)",
                          fontSize: "var(--text-xs)",
                          fontWeight: 700,
                          color: "var(--text-primary)",
                          cursor: "pointer",
                          minBlockSize: "var(--control-height-sm)",
                        }}
                      >
                        {col.label}
                        {renderSortIcon(col.key)}
                      </button>
                    </th>
                  ))}
                  <th scope="col" style={{ padding: "var(--space-3)" }}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedAnimals.map((animal) => {
                  const statusBadge =
                    animal.healthStatus === "alert"
                      ? { variant: "danger" as const, label: "Alert" }
                      : animal.healthStatus === "watch"
                        ? { variant: "warn" as const, label: "Watch" }
                        : { variant: "ok" as const, label: "Healthy" };

                  return (
                    <tr
                      key={animal.id}
                      data-testid={`herd-row-${animal.earTagNumber ?? animal.id}`}
                      onClick={() => setSelectedAnimalId(animal.id)}
                      style={{
                        borderBlockEnd: "1px solid var(--border-subtle)",
                        cursor: "pointer",
                        backgroundColor:
                          selectedAnimalId === animal.id
                            ? "var(--accent-primary-subtle)"
                            : "transparent",
                      }}
                    >
                      <td
                        className="tabular-nums"
                        style={{
                          padding: "var(--space-3)",
                          fontFamily: "var(--font-mono)",
                          fontWeight: 600,
                        }}
                      >
                        {animal.earTagNumber ?? animal.nationalId ?? "—"}
                      </td>
                      <td style={{ padding: "var(--space-3)", fontWeight: 700 }}>
                        {animal.name ?? "Unnamed"}
                      </td>
                      <td style={{ padding: "var(--space-3)", color: "var(--text-secondary)" }}>
                        {animal.groupName ?? "—"}
                      </td>
                      <td style={{ padding: "var(--space-3)", textTransform: "capitalize" }}>
                        {animal.species === "cattle"
                          ? `Cattle (${animal.breed ?? "Herd"})`
                          : `Horse (${animal.breed ?? "Stable"})`}
                      </td>
                      <td style={{ padding: "var(--space-3)" }}>
                        {animal.wearable ? (
                          <div
                            style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}
                          >
                            <Badge variant="info">{formatWearableKind(animal.wearable.kind)}</Badge>
                            {animal.wearable.batteryPct !== null && (
                              <span
                                className="tabular-nums"
                                style={{
                                  fontFamily: "var(--font-mono)",
                                  fontSize: "var(--text-xs)",
                                  color: "var(--text-secondary)",
                                }}
                              >
                                {animal.wearable.batteryPct}%
                              </span>
                            )}
                          </div>
                        ) : (
                          <span style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>
                            No sensor
                          </span>
                        )}
                      </td>
                      <td
                        className="tabular-nums"
                        style={{
                          padding: "var(--space-3)",
                          fontFamily: "var(--font-mono)",
                          color: "var(--text-secondary)",
                        }}
                      >
                        {animal.lastMilkingKg !== null ? `${animal.lastMilkingKg} kg` : "—"}
                      </td>
                      <td style={{ padding: "var(--space-3)" }}>
                        <Badge variant={statusBadge.variant}>{statusBadge.label}</Badge>
                      </td>
                      <td style={{ padding: "var(--space-3)" }}>
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<Eye size={15} />}
                          data-testid={`herd-inspect-${animal.earTagNumber ?? animal.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedAnimalId(animal.id);
                          }}
                        >
                          Inspect
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Drawer
        open={Boolean(selectedAnimalId && selectedAnimal)}
        onClose={() => setSelectedAnimalId(null)}
        title={
          selectedAnimal
            ? `${selectedAnimal.name ?? "Unnamed"} (${selectedAnimal.earTagNumber ?? selectedAnimal.nationalId ?? selectedAnimal.species})`
            : "Animal details"
        }
        subtitle={
          selectedAnimal
            ? `${selectedAnimal.species === "cattle" ? "Cattle" : "Horse"} · ${selectedAnimal.breed ?? "Standard"} · Group: ${selectedAnimal.groupName ?? "Ungrouped"}`
            : undefined
        }
        footer={
          selectedAnimal ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                inlineSize: "100%",
                gap: "var(--space-3)",
              }}
            >
              <Button
                variant="secondary"
                size="sm"
                icon={<Edit3 size={15} />}
                data-testid="animal-drawer-edit-btn"
                onClick={() => {
                  setEditingAnimal(selectedAnimal);
                  setAnimalFormOpen(true);
                }}
              >
                Edit details
              </Button>
              <Button
                variant="primary"
                size="md"
                icon={<MessageSquare size={17} />}
                data-testid="animal-drawer-ask-orion-btn"
                onClick={() => {
                  const label = `${selectedAnimal.name ?? "Animal"}${
                    selectedAnimal.earTagNumber ? ` (${selectedAnimal.earTagNumber})` : ""
                  }`;
                  const prompt = `Tell me about ${label} in ${selectedAnimal.groupName ?? "the barn"} and check recent sensor readings.`;
                  navigate(`/chat?prompt=${encodeURIComponent(prompt)}`);
                }}
              >
                {selectedAnimal.species === "horse"
                  ? "Ask Orion about this horse"
                  : "Ask Orion about this cow"}
              </Button>
            </div>
          ) : undefined
        }
      >
        {selectedAnimal && (
          <div
            data-testid="animal-detail-drawer"
            style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}
          >
            <section aria-label="Key animal facts">
              <h3
                style={{
                  margin: "0 0 var(--space-3) 0",
                  fontFamily: "var(--font-display)",
                  fontSize: "var(--text-base)",
                  fontWeight: 700,
                }}
              >
                Key facts
              </h3>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: "var(--space-3)",
                  padding: "var(--space-3) var(--space-4)",
                  borderRadius: "var(--radius-md)",
                  backgroundColor: "var(--bg-elevated)",
                  border: "1px solid var(--border-subtle)",
                  fontSize: "var(--text-sm)",
                }}
              >
                <div>
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                    Ear tag / Official ID
                  </div>
                  <div
                    className="tabular-nums"
                    style={{ fontFamily: "var(--font-mono)", fontWeight: 700 }}
                  >
                    {selectedAnimal.earTagNumber ?? selectedAnimal.nationalId ?? "—"}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                    Group
                  </div>
                  <div style={{ fontWeight: 700 }}>{selectedAnimal.groupName ?? "Ungrouped"}</div>
                </div>
                <div>
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                    Breed & Sex
                  </div>
                  <div style={{ fontWeight: 600 }}>
                    {selectedAnimal.breed ?? "—"} · {selectedAnimal.sex}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                    Birth date
                  </div>
                  <div className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
                    {selectedAnimal.birthDate ?? "—"}
                  </div>
                </div>
              </div>
            </section>

            <section aria-label="Wearable sensor binding">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "var(--space-2)",
                }}
              >
                <h3
                  style={{
                    margin: 0,
                    fontFamily: "var(--font-display)",
                    fontSize: "var(--text-base)",
                    fontWeight: 700,
                  }}
                >
                  Wearable sensor (max 1)
                </h3>
                <Badge variant={selectedWearable ? "info" : "neutral"}>
                  {selectedWearable ? formatWearableKind(selectedWearable.kind) : "No sensor"}
                </Badge>
              </div>

              <div
                data-testid="animal-drawer-wearable-card"
                style={{
                  padding: "var(--space-4)",
                  borderRadius: "var(--radius-md)",
                  backgroundColor: "var(--bg-elevated)",
                  border: "1px solid var(--border-subtle)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--space-3)",
                }}
              >
                {selectedWearable ? (
                  <>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "var(--space-3)",
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 700, fontSize: "var(--text-base)" }}>
                          {formatWearableKind(selectedWearable.kind)}{" "}
                          {selectedWearable.vendor ? `· ${selectedWearable.vendor}` : ""}
                        </div>
                        <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                          Active wearable sensor on this animal (collar OR bolus OR ear tag rule)
                        </div>
                      </div>
                      {selectedWearable.batteryPct !== null && (
                        <Badge
                          variant={selectedWearable.batteryPct < 25 ? "warn" : "ok"}
                          icon={<Battery size={13} />}
                        >
                          {selectedWearable.batteryPct}%
                        </Badge>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Link2 size={15} />}
                        data-testid="animal-drawer-attach-sensor-btn"
                        onClick={() => setAttachDialogOpen(true)}
                      >
                        Replace sensor
                      </Button>
                      <Button
                        variant="subtle"
                        size="sm"
                        icon={<Unlink size={15} />}
                        data-testid="animal-drawer-unbind-sensor-btn"
                        onClick={() =>
                          void handleUnbindWearable(
                            selectedWearable.deviceId,
                            selectedAnimal.name ?? selectedAnimal.earTagNumber ?? "animal",
                          )
                        }
                      >
                        Remove sensor
                      </Button>
                    </div>
                  </>
                ) : (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "var(--space-3)",
                      flexWrap: "wrap",
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 700, fontSize: "var(--text-sm)" }}>
                        No sensor attached
                      </div>
                      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                        Attach one collar, bolus, or ear tag sensor to track activity or
                        temperature.
                      </div>
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<Link2 size={15} />}
                      data-testid="animal-drawer-attach-sensor-btn"
                      onClick={() => setAttachDialogOpen(true)}
                    >
                      Attach sensor
                    </Button>
                  </div>
                )}
              </div>
            </section>

            <section aria-label="Recent observation sparklines">
              <h3
                style={{
                  margin: "0 0 var(--space-3) 0",
                  fontFamily: "var(--font-display)",
                  fontSize: "var(--text-base)",
                  fontWeight: 700,
                }}
              >
                Recent observations (7-day sparklines)
              </h3>
              {detailLoading && !selectedDetail ? (
                <div
                  style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-3)" }}
                >
                  <Skeleton height="5.5rem" />
                  <Skeleton height="5.5rem" />
                  <Skeleton height="5.5rem" />
                  <Skeleton height="5.5rem" />
                </div>
              ) : (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                    gap: "var(--space-3)",
                  }}
                >
                  <SparklineCard
                    title="Milk yield"
                    unit="kg"
                    observations={detailObservations.filter((o) => o.kind === "milking")}
                    color="var(--accent-primary)"
                    testId="sparkline-milking"
                  />
                  <SparklineCard
                    title="Activity"
                    unit="idx"
                    observations={detailObservations.filter((o) => o.kind === "activity")}
                    color="var(--status-info)"
                    testId="sparkline-activity"
                  />
                  <SparklineCard
                    title="Rumination"
                    unit="min/d"
                    observations={detailObservations.filter((o) => o.kind === "rumination")}
                    color="var(--status-ok)"
                    testId="sparkline-rumination"
                  />
                  <SparklineCard
                    title="Temperature"
                    unit="°C"
                    observations={detailObservations.filter((o) => o.kind === "temperature")}
                    color="var(--status-warn)"
                    testId="sparkline-temperature"
                  />
                </div>
              )}
            </section>
          </div>
        )}
      </Drawer>

      {selectedAnimal && (
        <AttachSensorDialog
          open={attachDialogOpen}
          onClose={() => setAttachDialogOpen(false)}
          animal={selectedAnimal}
          currentWearable={selectedWearable}
          wearableDevices={wearableDevices}
          allAnimals={enrichedAnimals}
          onBound={async () => {
            await Promise.all([
              refetchAnimals(),
              refetchDevices(),
              refetchDetail(),
              refetchAlerts(),
              refetchMilkings(),
            ]);
          }}
        />
      )}

      {animalFormOpen && (
        <AnimalFormDialog
          open={animalFormOpen}
          onClose={() => setAnimalFormOpen(false)}
          editingAnimal={editingAnimal}
          onSaved={async (savedId) => {
            await refetchAnimals();
            if (savedId) {
              setSelectedAnimalId(savedId);
              await refetchDetail();
            }
          }}
        />
      )}
    </div>
  );
}

export default HerdPage;
