import type { SVGProps } from "react";

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

const DEFAULT_SATELLITES: OrbitSatellite[] = [
  { id: "cattle", label: "Cattle", ring: 1, angleDeg: -38, tone: "ok", count: 24 },
  { id: "horses", label: "Horses", ring: 1, angleDeg: 142, tone: "ok", count: 4 },
  { id: "sensors", label: "Sensors", ring: 2, angleDeg: 32, tone: "accent", count: 24 },
  { id: "robot", label: "Milking robot", ring: 2, angleDeg: 215, tone: "ok", count: 1 },
  { id: "cameras", label: "Cameras", ring: 3, angleDeg: -115, tone: "ok", count: 3 },
  { id: "alerts", label: "Alerts", ring: 3, angleDeg: 85, tone: "warn", count: 3 },
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
  centerLabel = "BARN",
  centerSublabel = "Calm orbit",
  satellites = DEFAULT_SATELLITES,
  ...rest
}: OrbitRingsProps) {
  const cx = 150;
  const cy = 150;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 300 300"
      role="img"
      aria-label={`Farm orbit diagram: ${centerLabel} ${centerSublabel}`}
      style={{ display: "block", maxInlineSize: "100%", blockSize: "auto" }}
      {...rest}
    >
      <defs>
        <radialGradient id="orbit-core-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--accent-primary)" stopOpacity="0.18" />
          <stop offset="70%" stopColor="var(--accent-primary)" stopOpacity="0.04" />
          <stop offset="100%" stopColor="var(--accent-primary)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <circle cx={cx} cy={cy} r={140} fill="url(#orbit-core-glow)" />

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
        stroke="var(--accent-primary)"
        strokeWidth="2"
      />
      <text
        x={cx}
        y={cy - 3}
        textAnchor="middle"
        fill="var(--text-primary)"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: "12px",
          fontWeight: 700,
          letterSpacing: "0.06em",
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
          fontFamily: "var(--font-mono)",
          fontSize: "9.5px",
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
              strokeWidth="2.25"
            />
            {sat.count !== undefined ? (
              <text
                x={sx}
                y={sy + 3.5}
                textAnchor="middle"
                fill="var(--text-primary)"
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "9.5px",
                  fontWeight: 700,
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
