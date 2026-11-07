import type { Camera as CameraRow } from "@orbit/schema";
import { Video } from "lucide-react";
import { useT } from "../../i18n";

export function CameraSnapshotPlaceholder({ camera }: { readonly camera: CameraRow }) {
  const t = useT();
  const isOnline = camera.status === "online";

  return (
    <div data-testid={`camera-snapshot-${camera.id}`} className="orbit-camera-placeholder">
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 360 202"
        role="img"
        aria-label={t("cameras.snapshot.ariaLabel", { name: camera.name })}
        style={{ display: "block", inlineSize: "100%", blockSize: "100%" }}
      >
        <rect width="360" height="202" fill="var(--bg-elevated)" />
        <line
          x1="0"
          y1="101"
          x2="360"
          y2="101"
          stroke="var(--border-subtle)"
          strokeWidth="1"
          strokeDasharray="4 6"
        />
        <line
          x1="180"
          y1="0"
          x2="180"
          y2="202"
          stroke="var(--border-subtle)"
          strokeWidth="1"
          strokeDasharray="4 6"
        />
        <circle
          cx="180"
          cy="101"
          r="64"
          fill="none"
          stroke={isOnline ? "var(--orbit-ring-strong)" : "var(--border-strong)"}
          strokeWidth="1.5"
        />
        <circle
          cx="180"
          cy="101"
          r="34"
          fill="var(--orbit-core-bg)"
          stroke={isOnline ? "var(--status-ok)" : "var(--status-warn)"}
          strokeWidth="2"
        />
        <circle
          cx="180"
          cy="101"
          r="6"
          fill={isOnline ? "var(--status-ok)" : "var(--status-warn)"}
        />

        <path
          d="M 24 40 L 24 24 L 40 24"
          fill="none"
          stroke="var(--border-strong)"
          strokeWidth="2"
        />
        <path
          d="M 336 40 L 336 24 L 320 24"
          fill="none"
          stroke="var(--border-strong)"
          strokeWidth="2"
        />
        <path
          d="M 24 162 L 24 178 L 40 178"
          fill="none"
          stroke="var(--border-strong)"
          strokeWidth="2"
        />
        <path
          d="M 336 162 L 336 178 L 320 178"
          fill="none"
          stroke="var(--border-strong)"
          strokeWidth="2"
        />

        <text
          x="180"
          y="184"
          textAnchor="middle"
          fill="var(--text-secondary)"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "10.5px",
            fontWeight: 600,
          }}
        >
          {isOnline ? t("cameras.snapshot.live") : t("cameras.snapshot.offline")}
        </text>
      </svg>

      <div className="orbit-camera-placeholder__location">
        <Video size={13} style={{ color: isOnline ? "var(--status-ok)" : "var(--status-warn)" }} />
        <span>{camera.location ?? t("cameras.snapshot.locationFallback")}</span>
      </div>
    </div>
  );
}
