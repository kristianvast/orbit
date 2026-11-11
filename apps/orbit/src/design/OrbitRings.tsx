import type { SVGProps } from "react";
import { type MessageKey, useT } from "../i18n";

export interface OrbitSatellite {
  id: string;
  label: string;
  ring: 1 | 2 | 3;
  angleDeg: number;
  tone?: "ok" | "warn" | "danger" | "accent";
  count?: number;
}

export interface OrbitRingsProps extends SVGProps<SVGSVGElement> {
  size?: number;
  centerLabel?: string;
  centerSublabel?: string;
  satellites?: OrbitSatellite[];
}

type DefaultSatellite = Omit<OrbitSatellite, "label"> & { labelKey: MessageKey };

const DEFAULT_SATELLITES: readonly DefaultSatellite[] = [
  { id: "cattle", labelKey: "design.orbit.cattle", ring: 1, angleDeg: -38, tone: "ok", count: 24 },
  { id: "robot", labelKey: "design.orbit.robot", ring: 2, angleDeg: 215, tone: "ok", count: 1 },
  {
    id: "cameras",
    labelKey: "design.orbit.cameras",
    ring: 3,
    angleDeg: -115,
    tone: "ok",
    count: 3,
  },
  { id: "alerts", labelKey: "design.orbit.alerts", ring: 3, angleDeg: 85, tone: "warn", count: 3 },
];

const RING_RADII: Record<1 | 2 | 3, number> = {
  1: 58,
  2: 92,
  3: 124,
};

function toneColor(tone: OrbitSatellite["tone"]): string {
  switch (tone) {
    case "ok":
      return "var(--status-ok)";
    case "warn":
      return "var(--status-warn)";
    case "danger":
      return "var(--status-danger)";
    default:
      return "var(--accent-primary)";
  }
}

export function OrbitRings({
  size = 296,
  centerLabel: centerLabelProp,
  centerSublabel: centerSublabelProp,
  satellites: satellitesProp,
  ...rest
}: OrbitRingsProps) {
  const t = useT();
  const centerLabel = centerLabelProp ?? t("design.orbit.center");
  const centerSublabel = centerSublabelProp ?? t("design.orbit.sublabel");
  const satellites: OrbitSatellite[] =
    satellitesProp ??
    DEFAULT_SATELLITES.map(({ labelKey, ...sat }) => ({ ...sat, label: t(labelKey) }));
  const cx = 150;
  const cy = 150;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 300 300"
      role="img"
      aria-label={t("design.orbit.diagram", { center: centerLabel, sublabel: centerSublabel })}
      style={{ display: "block", maxInlineSize: "100%", blockSize: "auto" }}
      {...rest}
    >
      <line
        x1={cx - 134}
        y1={cy}
        x2={cx + 134}
        y2={cy}
        stroke="var(--border-subtle)"
        strokeWidth="1"
        strokeDasharray="3 5"
      />
      <line
        x1={cx}
        y1={cy - 134}
        x2={cx}
        y2={cy + 134}
        stroke="var(--border-subtle)"
        strokeWidth="1"
        strokeDasharray="3 5"
      />

      <circle
        cx={cx}
        cy={cy}
        r={RING_RADII[3]}
        fill="none"
        stroke="var(--orbit-ring)"
        strokeWidth="1.25"
        strokeDasharray="6 6"
      />
      <circle
        cx={cx}
        cy={cy}
        r={RING_RADII[2]}
        fill="none"
        stroke="var(--orbit-ring-secondary)"
        strokeWidth="1.5"
      />
      <circle
        cx={cx}
        cy={cy}
        r={RING_RADII[1]}
        fill="none"
        stroke="var(--orbit-ring-strong)"
        strokeWidth="1.75"
      />

      <circle
        cx={cx}
        cy={cy}
        r={34}
        fill="var(--orbit-core-bg)"
        stroke="var(--text-primary)"
        strokeWidth="1.5"
      />
      <text
        x={cx}
        y={cy - 2}
        textAnchor="middle"
        fill="var(--text-primary)"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "14px",
          fontWeight: 400,
          letterSpacing: "0.05em",
        }}
      >
        {centerLabel}
      </text>
      <text
        x={cx}
        y={cy + 12}
        textAnchor="middle"
        fill="var(--text-secondary)"
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "10px",
          fontWeight: 600,
        }}
      >
        {centerSublabel}
      </text>

      {satellites.map((sat) => {
        const radius = RING_RADII[sat.ring];
        const rad = (sat.angleDeg * Math.PI) / 180;
        const sx = cx + radius * Math.cos(rad);
        const sy = cy + radius * Math.sin(rad);
        const color = toneColor(sat.tone);

        return (
          <g key={sat.id}>
            <circle
              cx={sx}
              cy={sy}
              r={12}
              fill="var(--bg-surface)"
              stroke={color}
              strokeWidth="1.75"
            />
            {sat.count !== undefined ? (
              <text
                x={sx}
                y={sy + 3.5}
                textAnchor="middle"
                fill="var(--text-primary)"
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: "10px",
                  fontWeight: 700,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {sat.count}
              </text>
            ) : (
              <circle cx={sx} cy={sy} r={4.5} fill={color} />
            )}
          </g>
        );
      })}
    </svg>
  );
}
