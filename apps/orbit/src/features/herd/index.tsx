import type { ActiveWearable, AnimalInput } from "@orbit/protocol";
import type { Animal, AnimalSex, AnimalStatus, Observation, Species } from "@orbit/schema";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Battery,
  Edit3,
  Eye,
  LayoutGrid,
  MessageSquare,
  Orbit as OrbitIcon,
  Plus,
  RefreshCw,
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
import { type TranslateFn, useI18n, useT } from "../../i18n";
import { useOrion, useOrionQuery } from "../../lib/orion";
import { useFarmSpecies } from "../../lib/species";

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

const KNOWN_WEARABLE_KINDS = ["collar", "bolus", "ear_tag_sensor"] as const;
type KnownWearableKind = (typeof KNOWN_WEARABLE_KINDS)[number];

/** Plain-number formatting that keeps the raw reading (no grouping, no rounding). */
const PLAIN_NUMBER: Intl.NumberFormatOptions = { useGrouping: false, maximumFractionDigits: 20 };
const PERCENT: Intl.NumberFormatOptions = { style: "percent", maximumFractionDigits: 1 };

const STATUS_BADGE_VARIANT = {
  alert: "danger",
  watch: "warn",
  healthy: "ok",
} as const satisfies Record<HealthOrbitStatus, string>;

function isKnownWearableKind(kind: string): kind is KnownWearableKind {
  return (KNOWN_WEARABLE_KINDS as readonly string[]).includes(kind);
}

export function formatWearableKind(kind: string, t: TranslateFn): string {
  return isKnownWearableKind(kind) ? t(`herd.wearable.${kind}`) : kind.replace(/_/g, " ");
}

export function formatRelativeTime(iso: string | null | undefined, t: TranslateFn): string {
  if (!iso) return t("herd.time.never");
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return t("herd.time.justNow");
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return t("herd.time.minutesAgo", { count: Math.max(1, mins) });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("herd.time.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  return t("herd.time.daysAgo", { count: days });
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
  const { t, formatNumber } = useI18n();
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
            ? t("herd.value.withUnit", { value: formatNumber(latest.valueNum, PLAIN_NUMBER), unit })
            : t("herd.sparkline.noReadings")}
        </span>
      </div>

      {values.length > 0 ? (
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={t("herd.sparkline.trendChart", { title })}
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
          {t("herd.sparkline.waiting")}
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
  const t = useT();
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
          aria-label={t("herd.orbit.ariaLabel")}
          style={{ maxInlineSize: "100%", blockSize: "auto", display: "block" }}
        >
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
            {t("herd.orbit.core")}
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
            {t("herd.orbit.head", { count: animals.length })}
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
              const label = animal.name ?? animal.earTagNumber ?? t("herd.animal.fallback");
              const speciesCode = t(`herd.species.code.${animal.species}`);
              const statusCode = t(`herd.status.code.${animal.healthStatus}`);

              return (
                <a
                  key={animal.id}
                  href={`#animal-${animal.id}`}
                  aria-label={t("herd.orbit.dotAria", {
                    label,
                    id: animal.earTagNumber ?? speciesCode,
                    status: statusCode,
                  })}
                  data-testid={`herd-orbit-dot-${animal.earTagNumber ?? animal.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onSelectAnimal(animal.id);
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <title>
                    {t("herd.orbit.dotTitle", {
                      label,
                      id: animal.earTagNumber ?? animal.nationalId ?? speciesCode,
                      group: animal.groupName ?? t("herd.animal.ungrouped"),
                      status: statusCode.toUpperCase(),
                    })}
                  </title>
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
                fontWeight: "var(--display-weight)",
                lineHeight: 1,
              }}
            >
              {groupedByRing.alert.length}
            </span>
            <Badge variant="danger">{t("herd.orbit.ring.alert")}</Badge>
          </div>

          <div
            style={{
              padding: "var(--space-3) var(--space-4)",
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--bg-elevated)",
              border: "1px solid var(--border-subtle)",
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
                fontWeight: "var(--display-weight)",
                lineHeight: 1,
              }}
            >
              {groupedByRing.watch.length}
            </span>
            <Badge variant="warn">{t("herd.orbit.ring.watch")}</Badge>
          </div>

          <div
            style={{
              padding: "var(--space-3) var(--space-4)",
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--bg-elevated)",
              border: "1px solid var(--border-subtle)",
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
                fontWeight: "var(--display-weight)",
                lineHeight: 1,
              }}
            >
              {groupedByRing.healthy.length}
            </span>
            <Badge variant="ok">{t("herd.orbit.ring.healthy")}</Badge>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-3)",
          }}
        >
          <h3
            style={{
              margin: 0,
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-lg)",
              fontWeight: 600,
            }}
          >
            {t("herd.orbit.animalsHeading", { count: animals.length })}
          </h3>

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
              const statusLabel = t(`herd.status.${animal.healthStatus}`);

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
                      {animal.name ?? t("herd.animal.unnamed")}
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
                    {animal.earTagNumber ??
                      animal.nationalId ??
                      t(`herd.species.code.${animal.species}`)}{" "}
                    · {animal.groupName ?? t("herd.animal.ungrouped")}
                  </div>
                  {animal.wearable && (
                    <div
                      style={{
                        fontSize: "var(--text-xs)",
                        color: "var(--text-muted)",
                      }}
                    >
                      {`${formatWearableKind(animal.wearable.kind, t)}${
                        animal.wearable.vendor ? ` (${animal.wearable.vendor})` : ""
                      }`}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

interface AnimalFormDialogProps {
  open: boolean;
  onClose: () => void;
  editingAnimal: Animal | null;
  defaultSpecies: Species;
  onSaved: (savedId: string) => Promise<void>;
}

function AnimalFormDialog({
  open,
  onClose,
  editingAnimal,
  defaultSpecies,
  onSaved,
}: AnimalFormDialogProps) {
  const { client } = useOrion();
  const { pushToast } = useToast();
  const t = useT();

  const initialSpecies = editingAnimal?.species ?? defaultSpecies;
  const [species, setSpecies] = useState<Species>(initialSpecies);
  const [name, setName] = useState(editingAnimal?.name ?? "");
  const [earTagNumber, setEarTagNumber] = useState(editingAnimal?.earTagNumber ?? "");
  const [nationalId, setNationalId] = useState(editingAnimal?.nationalId ?? "");
  const [breed, setBreed] = useState(editingAnimal?.breed ?? "");
  const [sex, setSex] = useState<AnimalSex>(editingAnimal?.sex ?? "female");
  const [birthDate, setBirthDate] = useState(editingAnimal?.birthDate ?? "");
  const [groupName, setGroupName] = useState(
    editingAnimal?.groupName ??
      t(
        initialSpecies === "horse"
          ? "herd.form.defaultGroup.horse"
          : "herd.form.defaultGroup.cattle",
      ),
  );
  const [status, setStatus] = useState<AnimalStatus>(editingAnimal?.status ?? "active");
  const [notes, setNotes] = useState(editingAnimal?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!client) return;
    if (!name.trim() && !earTagNumber.trim()) {
      setError(t("herd.form.error.nameOrTag"));
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
        title: editingAnimal ? t("herd.form.toast.updated") : t("herd.form.toast.added"),
        description: t("herd.form.toast.saved", { animal: name.trim() || earTagNumber.trim() }),
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
          ? t("herd.form.title.edit", {
              animal:
                editingAnimal.name ?? editingAnimal.earTagNumber ?? t("herd.animal.fallbackLower"),
            })
          : t(species === "horse" ? "herd.form.title.add.horse" : "herd.form.title.add.cattle")
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} data-testid="animal-form-cancel">
            {t("herd.form.cancel")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="herd-animal-form"
            loading={saving}
            data-testid="animal-form-submit"
          >
            {editingAnimal ? t("herd.form.submit.save") : t("herd.form.submit.add")}
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
          label={t("herd.form.species")}
          data-testid="animal-form-species"
          value={species}
          onChange={(e) => {
            const nextSpecies = e.target.value as Species;
            setSpecies(nextSpecies);
            if (nextSpecies === "horse" && groupName === t("herd.form.defaultGroup.cattle")) {
              setGroupName(t("herd.form.defaultGroup.horse"));
            }
          }}
          options={[
            { value: "cattle", label: t("herd.form.species.cattle") },
            { value: "horse", label: t("herd.form.species.horse") },
          ]}
        />
        <Select
          label={t("herd.form.status")}
          data-testid="animal-form-status"
          value={status}
          onChange={(e) => setStatus(e.target.value as AnimalStatus)}
          options={[
            { value: "active", label: t("herd.form.status.active") },
            { value: "sold", label: t("herd.form.status.sold") },
            { value: "dead", label: t("herd.form.status.dead") },
          ]}
        />

        <Input
          label={t("herd.form.name")}
          data-testid="animal-form-name"
          placeholder={
            species === "horse"
              ? t("herd.form.name.placeholderHorse")
              : t("herd.form.name.placeholderCattle")
          }
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          label={t("herd.form.earTag")}
          data-testid="animal-form-eartag"
          placeholder={
            species === "horse"
              ? t("herd.form.earTag.placeholderHorse")
              : t("herd.form.earTag.placeholderCattle")
          }
          value={earTagNumber}
          onChange={(e) => setEarTagNumber(e.target.value)}
        />

        <Input
          label={t("herd.form.group")}
          data-testid="animal-form-group"
          placeholder={t("herd.form.group.placeholder")}
          value={groupName}
          onChange={(e) => setGroupName(e.target.value)}
        />
        <Input
          label={t("herd.form.breed")}
          data-testid="animal-form-breed"
          placeholder={
            species === "horse"
              ? t("herd.form.breed.placeholderHorse")
              : t("herd.form.breed.placeholderCattle")
          }
          value={breed}
          onChange={(e) => setBreed(e.target.value)}
        />

        <Select
          label={t("herd.form.sex")}
          data-testid="animal-form-sex"
          value={sex}
          onChange={(e) => setSex(e.target.value as AnimalSex)}
          options={[
            {
              value: "female",
              label: t(species === "horse" ? "herd.form.sex.female.horse" : "herd.form.sex.female"),
            },
            {
              value: "male",
              label: t(species === "horse" ? "herd.form.sex.male.horse" : "herd.form.sex.male"),
            },
            {
              value: "castrated",
              label: t(
                species === "horse" ? "herd.form.sex.castrated.horse" : "herd.form.sex.castrated",
              ),
            },
            { value: "unknown", label: t("herd.form.sex.unknown") },
          ]}
        />
        <Input
          label={t("herd.form.birthDate")}
          type="date"
          data-testid="animal-form-birthdate"
          value={birthDate}
          onChange={(e) => setBirthDate(e.target.value)}
        />

        <div style={{ gridColumn: "1 / -1" }}>
          <Input
            label={t("herd.form.nationalId")}
            data-testid="animal-form-national-id"
            placeholder={t("herd.form.nationalId.placeholder")}
            value={nationalId}
            onChange={(e) => setNationalId(e.target.value)}
          />
        </div>

        <div style={{ gridColumn: "1 / -1" }}>
          <Input
            label={t("herd.form.notes")}
            data-testid="animal-form-notes"
            placeholder={t("herd.form.notes.placeholder")}
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
  const { t, formatNumber } = useI18n();
  const { species: farmSpecies } = useFarmSpecies();

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

  const { data: alertsData } = useOrionQuery(
    "observations.recent",
    { alertsOnly: true, limit: 100 },
    { refetchTables: ["observations"] },
  );

  const { data: milkingsData } = useOrionQuery(
    "observations.recent",
    { kind: "milking", limit: 300 },
    { refetchTables: ["observations"] },
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

  const handleSort = (field: HerdSortField) => {
    if (sortField === field) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("asc");
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

  const isHorseFarm = farmSpecies === "horse";
  const hasCattle = enrichedAnimals.some((a) => a.species === "cattle");
  const hasHorses = enrichedAnimals.some((a) => a.species === "horse");
  const hasBothSpecies = hasCattle && hasHorses;
  const hasAnyWearable = sortedAnimals.some((a) => a.wearable !== null);
  const showMilkingColumn = !isHorseFarm || hasCattle;

  const visibleColumns: readonly HerdSortField[] = [
    "earTagNumber",
    "name",
    "groupName",
    ...(hasBothSpecies ? (["species"] as const) : []),
    ...(hasAnyWearable ? (["wearable"] as const) : []),
    ...(showMilkingColumn ? (["lastMilking"] as const) : []),
    "status",
  ];

  return (
    <div className="orbit-container" data-testid="herd-page">
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "var(--space-4)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <h1
            style={{
              margin: 0,
              fontFamily: "var(--font-display)",
              fontSize: "var(--text-h1)",
              fontWeight: 400,
              lineHeight: "var(--leading-tight)",
              letterSpacing: "var(--tracking-display)",
            }}
          >
            {t(isHorseFarm ? "herd.page.title.horse" : "herd.page.title.cattle")}
          </h1>
          <Badge variant="neutral" className="tabular-nums">
            {t("herd.page.shown", { count: filteredAnimals.length })}
          </Badge>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "var(--space-3)",
          }}
        >
          <div className="orbit-tablist" role="tablist" aria-label={t("herd.page.viewMode")}>
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
              {t("herd.page.viewOrbit")}
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
              {t("herd.page.viewTable")}
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
            {t(isHorseFarm ? "herd.page.addAnimal.horse" : "herd.page.addAnimal.cattle")}
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
            label={t("herd.filter.search")}
            data-testid="herd-search-input"
            placeholder={t("herd.filter.search.placeholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          {hasBothSpecies && (
            <Select
              label={t("herd.filter.species")}
              data-testid="herd-filter-species"
              value={speciesFilter}
              onChange={(e) => setSpeciesFilter(e.target.value)}
              options={[
                { value: "all", label: t("herd.filter.species.all") },
                { value: "cattle", label: t("herd.filter.species.cattle") },
                { value: "horse", label: t("herd.filter.species.horse") },
              ]}
            />
          )}

          <Select
            label={t("herd.filter.group")}
            data-testid="herd-filter-group"
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            options={[
              { value: "all", label: t("herd.filter.group.all") },
              ...availableGroups.map((g) => ({ value: g, label: g })),
            ]}
          />

          <Select
            label={t("herd.filter.status")}
            data-testid="herd-filter-status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={[
              { value: "active", label: t("herd.filter.status.active") },
              { value: "all", label: t("herd.filter.status.all") },
              { value: "sold", label: t("herd.filter.status.sold") },
              { value: "dead", label: t("herd.filter.status.dead") },
            ]}
          />
        </div>
      </Card>

      {animalsError ? (
        <Card title={t("herd.error.title")} data-testid="herd-error-state">
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
              {t("herd.error.retry")}
            </Button>
          </div>
        </Card>
      ) : animalsLoading && !animalsData ? (
        <Card title={t("herd.loading.title")} data-testid="herd-loading-state">
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
          title={t(isHorseFarm ? "herd.empty.title.horse" : "herd.empty.title.cattle")}
          action={
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)" }}>
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
                  {t("herd.empty.reset")}
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
                {t(isHorseFarm ? "herd.page.addAnimal.horse" : "herd.page.addAnimal.cattle")}
              </Button>
            </div>
          }
        />
      ) : viewMode === "orbit" ? (
        <Card title={t("herd.orbitCard.title")}>
          <HerdOrbitCanvas
            animals={sortedAnimals}
            selectedAnimalId={selectedAnimalId}
            onSelectAnimal={(id) => setSelectedAnimalId(id)}
          />
        </Card>
      ) : (
        <Card title={t("herd.table.title")}>
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
                  {visibleColumns
                    .map((key) => ({ key, label: t(`herd.table.col.${key}`) }))
                    .map((col) => (
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
                    {t("herd.table.col.actions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedAnimals.map((animal) => {
                  const statusBadge = {
                    variant: STATUS_BADGE_VARIANT[animal.healthStatus],
                    label: t(`herd.status.${animal.healthStatus}`),
                  };

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
                        {animal.name ?? t("herd.animal.unnamed")}
                      </td>
                      <td style={{ padding: "var(--space-3)", color: "var(--text-secondary)" }}>
                        {animal.groupName ?? "—"}
                      </td>
                      {hasBothSpecies && (
                        <td style={{ padding: "var(--space-3)", textTransform: "capitalize" }}>
                          {animal.species === "cattle"
                            ? t("herd.table.species.cattle", {
                                breed: animal.breed ?? t("herd.table.breedFallback.cattle"),
                              })
                            : t("herd.table.species.horse", {
                                breed: animal.breed ?? t("herd.table.breedFallback.horse"),
                              })}
                        </td>
                      )}
                      {hasAnyWearable && (
                        <td style={{ padding: "var(--space-3)" }}>
                          {animal.wearable ? (
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "var(--space-2)",
                              }}
                            >
                              <Badge variant="info">
                                {formatWearableKind(animal.wearable.kind, t)}
                              </Badge>
                              {animal.wearable.batteryPct !== null && (
                                <span
                                  className="tabular-nums"
                                  style={{
                                    fontFamily: "var(--font-mono)",
                                    fontSize: "var(--text-xs)",
                                    color: "var(--text-secondary)",
                                  }}
                                >
                                  {formatNumber(animal.wearable.batteryPct / 100, PERCENT)}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span style={{ color: "var(--text-muted)" }}>—</span>
                          )}
                        </td>
                      )}
                      {showMilkingColumn && (
                        <td
                          className="tabular-nums"
                          style={{
                            padding: "var(--space-3)",
                            fontFamily: "var(--font-mono)",
                            color: "var(--text-secondary)",
                          }}
                        >
                          {animal.lastMilkingKg !== null
                            ? t("herd.value.withUnit", {
                                value: formatNumber(animal.lastMilkingKg, PLAIN_NUMBER),
                                unit: t("herd.unit.kg"),
                              })
                            : "—"}
                        </td>
                      )}
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
                          {t("herd.table.inspect")}
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
            ? t("herd.drawer.title", {
                name: selectedAnimal.name ?? t("herd.animal.unnamed"),
                id:
                  selectedAnimal.earTagNumber ??
                  selectedAnimal.nationalId ??
                  t(`herd.species.code.${selectedAnimal.species}`),
              })
            : t("herd.drawer.fallbackTitle")
        }
        subtitle={
          selectedAnimal
            ? t("herd.drawer.subtitle", {
                species: t(`herd.species.${selectedAnimal.species}`),
                breed: selectedAnimal.breed ?? t("herd.drawer.breedFallback"),
                group: selectedAnimal.groupName ?? t("herd.animal.ungrouped"),
              })
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
                {t("herd.drawer.edit")}
              </Button>
              <Button
                variant="primary"
                size="md"
                icon={<MessageSquare size={17} />}
                data-testid="animal-drawer-ask-orion-btn"
                onClick={() => {
                  const label = t("herd.drawer.askLabel", {
                    name: selectedAnimal.name ?? t("herd.animal.fallback"),
                    tag: selectedAnimal.earTagNumber
                      ? t("herd.drawer.askTag", { tag: selectedAnimal.earTagNumber })
                      : "",
                  });
                  const prompt = t("herd.drawer.askPrompt", {
                    animal: label,
                    group: selectedAnimal.groupName ?? t("herd.drawer.askGroupFallback"),
                  });
                  navigate(`/chat?prompt=${encodeURIComponent(prompt)}`);
                }}
              >
                {selectedAnimal.species === "horse"
                  ? t("herd.drawer.askHorse")
                  : t("herd.drawer.askCow")}
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
            <section aria-label={t("herd.drawer.factsAria")}>
              <h3
                style={{
                  margin: "0 0 var(--space-3) 0",
                  fontFamily: "var(--font-display)",
                  fontSize: "var(--text-base)",
                  fontWeight: 700,
                }}
              >
                {t("herd.drawer.factsHeading")}
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
                    {t("herd.drawer.fact.id")}
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
                    {t("herd.drawer.fact.group")}
                  </div>
                  <div style={{ fontWeight: 700 }}>
                    {selectedAnimal.groupName ?? t("herd.animal.ungrouped")}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                    {t("herd.drawer.fact.breedSex")}
                  </div>
                  <div style={{ fontWeight: 600 }}>
                    {selectedAnimal.breed ?? "—"} · {t(`herd.sex.short.${selectedAnimal.sex}`)}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                    {t("herd.drawer.fact.birthDate")}
                  </div>
                  <div className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
                    {selectedAnimal.birthDate ?? "—"}
                  </div>
                </div>
              </div>
            </section>

            {selectedWearable && (
              <section aria-label={t("herd.drawer.wearableAria")}>
                <h3
                  style={{
                    margin: "0 0 var(--space-2) 0",
                    fontFamily: "var(--font-sans)",
                    fontSize: "var(--text-base)",
                    fontWeight: 600,
                  }}
                >
                  {t("herd.drawer.wearableHeading")}
                </h3>

                <div
                  data-testid="animal-drawer-wearable-card"
                  style={{
                    padding: "var(--space-3) var(--space-4)",
                    borderRadius: "var(--radius-md)",
                    backgroundColor: "var(--bg-elevated)",
                    border: "1px solid var(--border-subtle)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "var(--space-3)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                    <Badge variant="info">{formatWearableKind(selectedWearable.kind, t)}</Badge>
                    {selectedWearable.vendor && (
                      <span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
                        {selectedWearable.vendor}
                      </span>
                    )}
                  </div>
                  {selectedWearable.batteryPct !== null && (
                    <Badge
                      variant={selectedWearable.batteryPct < 25 ? "warn" : "ok"}
                      icon={<Battery size={13} />}
                    >
                      {formatNumber(selectedWearable.batteryPct / 100, PERCENT)}
                    </Badge>
                  )}
                </div>
              </section>
            )}

            <section aria-label={t("herd.drawer.observationsAria")}>
              <h3
                style={{
                  margin: "0 0 var(--space-3) 0",
                  fontFamily: "var(--font-sans)",
                  fontSize: "var(--text-base)",
                  fontWeight: 600,
                }}
              >
                {t("herd.drawer.observationsHeading")}
              </h3>
              {detailLoading && !selectedDetail ? (
                <div
                  style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-3)" }}
                >
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
                  {selectedAnimal.species !== "horse" && (
                    <SparklineCard
                      title={t("herd.sparkline.milking")}
                      unit={t("herd.unit.kg")}
                      observations={detailObservations.filter((o) => o.kind === "milking")}
                      color="var(--accent-primary)"
                      testId="sparkline-milking"
                    />
                  )}
                  <SparklineCard
                    title={t("herd.sparkline.activity")}
                    unit={t("herd.unit.activity")}
                    observations={detailObservations.filter((o) => o.kind === "activity")}
                    color="var(--status-info)"
                    testId="sparkline-activity"
                  />
                  <SparklineCard
                    title={t("herd.sparkline.rumination")}
                    unit={t("herd.unit.rumination")}
                    observations={detailObservations.filter((o) => o.kind === "rumination")}
                    color="var(--status-ok)"
                    testId="sparkline-rumination"
                  />
                  <SparklineCard
                    title={t("herd.sparkline.temperature")}
                    unit={t("herd.unit.temperature")}
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

      {animalFormOpen && (
        <AnimalFormDialog
          open={animalFormOpen}
          onClose={() => setAnimalFormOpen(false)}
          editingAnimal={editingAnimal}
          defaultSpecies={farmSpecies}
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
