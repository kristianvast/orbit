import {
  easeOut,
  mix,
  type OrbPalette,
  type Rgb,
  rgba,
  type SpherePoint,
  truncateLabel,
} from "./orb-palette";
import type { ActivityRowView, VoiceCallState } from "./types";

export type OrbVariant = "stage" | "widget" | "dock";

export interface TrackedChip {
  readonly id: string;
  readonly label: string;
  readonly status: ActivityRowView["status"];
  readonly startedAtSec: number;
  readonly endedAtSec: number;
}

export const RETURN_SECONDS = 1.2;
const LAUNCH_SECONDS = 0.4;
const TAU = Math.PI * 2;

function paintOrbChip(
  ctx: CanvasRenderingContext2D,
  palette: OrbPalette,
  pos: { readonly x: number; readonly y: number; readonly canvasW: number },
  chip: {
    readonly text: string;
    readonly col: Rgb;
    readonly alpha: number;
    readonly running: boolean;
  },
): void {
  const short = truncateLabel(chip.text, pos.canvasW < 400 ? 22 : 30);
  ctx.save();
  ctx.globalAlpha = chip.alpha;
  ctx.font = `600 11px ${palette.fontSans}`;
  const chipW = Math.min(pos.canvasW - 16, ctx.measureText(short).width + 22);
  const chipH = 22;
  ctx.fillStyle = rgba(palette.surface, palette.isDark ? 0.94 : 0.96);
  ctx.strokeStyle = rgba(chip.col, chip.running ? 0.85 : 0.55);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(pos.x - chipW / 2, pos.y - chipH / 2, chipW, chipH, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = rgba(chip.col, 1);
  ctx.beginPath();
  ctx.arc(pos.x - chipW / 2 + 8, pos.y, 2.5, 0, TAU);
  ctx.fill();
  ctx.fillStyle = rgba(palette.text, 0.94);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(short, pos.x - chipW / 2 + 15, pos.y + 0.5);
  ctx.restore();
}

function paintOrbTransfer(
  ctx: CanvasRenderingContext2D,
  palette: OrbPalette,
  geom: {
    readonly coreX: number;
    readonly coreY: number;
    readonly toX: number;
    readonly toY: number;
    readonly radius: number;
  },
  anim: { readonly chip: TrackedChip; readonly t: number; readonly reducedMotion: boolean },
): void {
  const running = anim.chip.status === "running";
  const fade = running ? 1 : Math.max(0, 1 - (anim.t - anim.chip.endedAtSec) / RETURN_SECONDS);
  if (fade <= 0) return;
  const dx = geom.toX - geom.coreX;
  const dy = geom.toY - geom.coreY;
  const dist = Math.hypot(dx, dy) || 1;
  const fromX = geom.coreX + (dx / dist) * geom.radius * 0.6;
  const fromY = geom.coreY + (dy / dist) * geom.radius * 0.6;
  const col = anim.chip.status === "error" ? palette.danger : running ? palette.accent : palette.ok;

  ctx.save();
  ctx.globalAlpha = fade * 0.85;
  ctx.strokeStyle = rgba(col, 0.75);
  ctx.lineWidth = 1.25;
  ctx.setLineDash([5, 4]);
  if (!anim.reducedMotion) ctx.lineDashOffset = running ? -anim.t * 32 : anim.t * 32;
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(geom.toX, geom.toY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

export interface OrbSceneFrame {
  readonly ctx: CanvasRenderingContext2D;
  readonly palette: OrbPalette;
  readonly pts: readonly SpherePoint[];
  readonly variant: OrbVariant;
  readonly w: number;
  readonly h: number;
  readonly dpr: number;
  readonly t: number;
  readonly spin: number;
  readonly smoothLevel: number;
  readonly currentCol: Rgb;
  readonly currentState: VoiceCallState;
  readonly stateLabel: string;
  readonly wordmark: string;
  readonly reducedMotion: boolean;
  readonly chips: readonly TrackedChip[];
}

export function drawOrbScene(f: OrbSceneFrame): void {
  const { ctx, palette, pts, variant, w, h, dpr, t } = f;
  if (!w || !h) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const R =
    variant === "dock"
      ? Math.min(w, h) * 0.38
      : variant === "widget"
        ? Math.min(h * 0.34, w * 0.24)
        : Math.min(h * 0.36, w * 0.25);
  const liveChips =
    variant !== "dock" && w >= 220 && h >= 120
      ? f.chips.filter((c) => c.status === "running" || t - c.endedAtSec < RETURN_SECONDS)
      : [];
  const rxOrbit = Math.min(R * 1.85, w / 2 - 28);
  const ryOrbit = R * 0.44;
  const ry = f.reducedMotion ? 0.5 : t * 0.24;
  const rx = f.reducedMotion ? 0.36 : 0.36 + Math.sin(t * 0.18) * 0.07;
  const [cyR, syR, cxR, sxR] = [Math.cos(ry), Math.sin(ry), Math.cos(rx), Math.sin(rx)];

  const hasRunning = f.chips.some((c) => c.status === "running") || f.currentState === "working";
  const workPulse = f.reducedMotion
    ? 0
    : hasRunning
      ? 0.28 + 0.12 * Math.sin(t * 4.8)
      : f.currentState === "connecting"
        ? 0.16 + 0.08 * Math.sin(t * 3.4)
        : 0;
  const effLevel = Math.max(f.smoothLevel, workPulse);

  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.65);
  grad.addColorStop(0, rgba(f.currentCol, (palette.isDark ? 0.22 : 0.14) + effLevel * 0.24));
  grad.addColorStop(0.55, rgba(f.currentCol, palette.isDark ? 0.05 : 0.03));
  grad.addColorStop(1, rgba(f.currentCol, 0));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  if (variant !== "dock") {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.06);
    ctx.strokeStyle = rgba(palette.border, liveChips.length > 0 ? 0.55 : 0.32);
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.ellipse(0, 0, Math.max(R * 1.2, rxOrbit), ryOrbit, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  const placed = liveChips.map((c, idx) => {
    const a = f.spin + (idx * TAU) / Math.max(1, liveChips.length);
    const oz = Math.sin(a);
    const targetX = Math.min(w - 64, Math.max(64, cx + Math.cos(a) * rxOrbit));
    const targetY = cy + oz * ryOrbit - Math.cos(a) * R * 0.1;
    const k = f.reducedMotion ? 1 : easeOut((t - c.startedAtSec) / LAUNCH_SECONDS);
    return { chip: c, z: oz, x: cx + (targetX - cx) * k, y: cy + (targetY - cy) * k, k };
  });

  for (const p of placed) {
    if (p.z > 0) continue;
    const col =
      p.chip.status === "error"
        ? palette.danger
        : p.chip.status === "running"
          ? palette.accent
          : palette.ok;
    paintOrbChip(
      ctx,
      palette,
      { x: p.x, y: p.y, canvasW: w },
      { text: p.chip.label, col, alpha: 0.48 * p.k, running: p.chip.status === "running" },
    );
  }

  for (const pt of pts) {
    const wave = f.reducedMotion
      ? 0
      : effLevel * 0.18 * Math.sin(pt.x * 5 + t * 4) * Math.cos(pt.y * 6 - t * 3) +
        0.02 * Math.sin(t * 1.3 + pt.s * TAU);
    const d = 1 + wave;
    const [x, y, z] = [pt.x * d, pt.y * d, pt.z * d];
    const x1 = x * cyR + z * syR;
    const z1 = -x * syR + z * cyR;
    const y2 = y * cxR - z1 * sxR;
    const z2 = y * sxR + z1 * cxR;
    const k = 1.9 / (2.4 - z2 * 0.5);
    const depth = (z2 + 1) / 2;
    const dotCol = mix(f.currentCol, palette.secondary, ((pt.y + 1) / 2) * 0.38);
    const alpha = palette.isDark ? 0.12 + 0.78 * depth * depth : 0.16 + 0.76 * depth * depth;
    ctx.fillStyle = rgba(dotCol, alpha);
    const size = (variant === "dock" ? 0.7 : 0.75) + depth * (variant === "dock" ? 1.1 : 1.55);
    ctx.fillRect(cx + x1 * R * k - size / 2, cy + y2 * R * k - size / 2, size, size);
  }

  for (const p of placed) {
    paintOrbTransfer(
      ctx,
      palette,
      { coreX: cx, coreY: cy, toX: p.x, toY: p.y, radius: R },
      { chip: p.chip, t, reducedMotion: f.reducedMotion },
    );
    if (p.z <= 0) continue;
    const col =
      p.chip.status === "error"
        ? palette.danger
        : p.chip.status === "running"
          ? palette.accent
          : palette.ok;
    paintOrbChip(
      ctx,
      palette,
      { x: p.x, y: p.y, canvasW: w },
      { text: p.chip.label, col, alpha: 0.95 * p.k, running: p.chip.status === "running" },
    );
  }

  if (variant !== "dock" && R >= 34) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.font = `400 ${variant === "stage" ? 24 : 18}px ${palette.fontDisplay}`;
    ctx.fillStyle = rgba(palette.text, 0.96);
    ctx.fillText(f.wordmark, cx, cy + 4);
    ctx.font = `600 ${variant === "stage" ? 11 : 10}px ${palette.fontMono}`;
    ctx.fillStyle = rgba(f.currentCol, 0.96);
    ctx.fillText(f.stateLabel, cx, cy + (variant === "stage" ? 21 : 20));
    ctx.restore();
  }
}
