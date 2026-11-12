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
  /** 0 in orbit, 1 docked in the top-right corner; eased every frame. */
  dock: number;
}

export const RETURN_SECONDS = 1.4;
const LAUNCH_SECONDS = 0.45;
const FOCUS_HOLD_SECONDS = 1.2;
const TAU = Math.PI * 2;

function chipColor(palette: OrbPalette, status: TrackedChip["status"]): Rgb {
  return status === "error" ? palette.danger : status === "running" ? palette.accent : palette.ok;
}

function chipWidth(ctx: CanvasRenderingContext2D, palette: OrbPalette, text: string): number {
  ctx.font = `600 11px ${palette.fontSans}`;
  return ctx.measureText(text).width + 24;
}

function paintOrbChip(
  ctx: CanvasRenderingContext2D,
  palette: OrbPalette,
  pos: { readonly x: number; readonly y: number },
  chip: {
    readonly text: string;
    readonly width: number;
    readonly col: Rgb;
    readonly alpha: number;
    readonly active: boolean;
  },
): void {
  const chipH = 22;
  ctx.save();
  ctx.globalAlpha = chip.alpha;
  ctx.font = `600 11px ${palette.fontSans}`;
  if (chip.active) {
    ctx.shadowColor = rgba(chip.col, 0.7);
    ctx.shadowBlur = 14;
  }
  ctx.fillStyle = rgba(palette.surface, palette.isDark ? 0.94 : 0.97);
  ctx.strokeStyle = rgba(chip.col, chip.active ? 0.95 : 0.6);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(pos.x - chip.width / 2, pos.y - chipH / 2, chip.width, chipH, 5);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.stroke();
  if (chip.active) {
    ctx.fillStyle = rgba(chip.col, 0.12);
    ctx.fill();
  }
  ctx.fillStyle = rgba(chip.col, 1);
  ctx.beginPath();
  ctx.arc(pos.x - chip.width / 2 + 8, pos.y, 2.5, 0, TAU);
  ctx.fill();
  ctx.fillStyle = rgba(palette.text, 0.94);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(chip.text, pos.x - chip.width / 2 + 15, pos.y + 0.5);
  ctx.restore();
}

/** Data streams out to a running tool and back into the core when it finishes (as on the demo). */
function paintOrbTransfer(
  ctx: CanvasRenderingContext2D,
  palette: OrbPalette,
  geom: {
    readonly coreX: number;
    readonly coreY: number;
    readonly toX: number;
    readonly toY: number;
    readonly radius: number;
    readonly coreCol: Rgb;
  },
  anim: { readonly chip: TrackedChip; readonly t: number; readonly reducedMotion: boolean },
): void {
  const running = anim.chip.status === "running";
  const fade = running ? 1 : Math.max(0, 1 - (anim.t - anim.chip.endedAtSec) / RETURN_SECONDS);
  if (fade <= 0) return;
  const dx = geom.toX - geom.coreX;
  const dy = geom.toY - geom.coreY;
  const dist = Math.hypot(dx, dy) || 1;
  const fromX = geom.coreX + (dx / dist) * geom.radius * 0.55;
  const fromY = geom.coreY + (dy / dist) * geom.radius * 0.55;
  const col = anim.chip.status === "error" ? palette.danger : running ? geom.coreCol : palette.ok;
  const t = anim.reducedMotion ? 0 : anim.t;

  ctx.save();
  ctx.globalAlpha = fade;
  ctx.strokeStyle = rgba(col, 0.25);
  ctx.lineWidth = 5;
  ctx.shadowColor = rgba(col, 0.7);
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(geom.toX, geom.toY);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = rgba(mix(col, palette.text, 0.35), 0.9);
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.lineDashOffset = running ? -t * 40 : t * 40;
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(geom.toX, geom.toY);
  ctx.stroke();
  ctx.setLineDash([]);
  if (!anim.reducedMotion) {
    for (let k = 0; k < 3; k++) {
      let p = (t * (running ? 1.1 : 1.6) + k / 3) % 1;
      if (!running) p = 1 - p;
      ctx.fillStyle = rgba(palette.isDark ? palette.text : palette.surface, 1);
      ctx.shadowColor = rgba(col, 1);
      ctx.shadowBlur = 8;
      ctx.fillRect(
        fromX + (geom.toX - fromX) * p - 2.5,
        fromY + (geom.toY - fromY) * p - 2.5,
        5,
        5,
      );
    }
    ctx.shadowBlur = 0;
  }
  ctx.strokeStyle = rgba(col, 0.9);
  ctx.lineWidth = 1.25;
  for (const [ex, ey] of [
    [fromX, fromY],
    [geom.toX, geom.toY],
  ] as const) {
    ctx.beginPath();
    ctx.arc(ex, ey, 4 + Math.sin(t * 8) * 0.8, 0, TAU);
    ctx.stroke();
  }
  ctx.restore();
}

function paintHud(
  ctx: CanvasRenderingContext2D,
  palette: OrbPalette,
  text: string,
  at: { readonly x: number; readonly y: number; readonly align: CanvasTextAlign },
  col: Rgb,
  alpha: number,
): void {
  ctx.save();
  ctx.font = `500 10px ${palette.fontMono}`;
  ctx.fillStyle = rgba(col, alpha);
  ctx.textAlign = at.align;
  ctx.textBaseline = "middle";
  ctx.fillText(text, at.x, at.y);
  ctx.restore();
}

function paintBrackets(ctx: CanvasRenderingContext2D, palette: OrbPalette, w: number, h: number) {
  const inset = 10;
  const len = 12;
  ctx.save();
  ctx.strokeStyle = rgba(palette.secondary, 0.45);
  ctx.lineWidth = 1;
  for (const [x, y, sx, sy] of [
    [inset, inset, 1, 1],
    [w - inset, inset, -1, 1],
    [inset, h - inset, 1, -1],
    [w - inset, h - inset, -1, -1],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(x, y + sy * len);
    ctx.lineTo(x, y);
    ctx.lineTo(x + sx * len, y);
    ctx.stroke();
  }
  ctx.restore();
}

/** The newest tool that is running or finished a moment ago; it docks in the corner. */
function focusIndex(chips: readonly TrackedChip[], t: number): number {
  for (let i = chips.length - 1; i >= 0; i--) {
    const c = chips[i];
    if (c && (c.status === "running" || t < c.endedAtSec + RETURN_SECONDS + FOCUS_HOLD_SECONDS))
      return i;
  }
  return -1;
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
  readonly hudTitle: string;
  readonly hudActions: string;
  readonly reducedMotion: boolean;
  readonly chips: readonly TrackedChip[];
}

export function drawOrbScene(f: OrbSceneFrame): void {
  const { ctx, palette, pts, variant, w, h, dpr, t } = f;
  if (!w || !h) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const isDock = variant === "dock";
  const cx = w / 2;
  const cy = isDock ? h / 2 : h / 2 + 4;
  const R = isDock ? Math.min(w, h) * 0.38 : Math.min(h * 0.3, w * 0.19);
  const chips = !isDock && w >= 220 && h >= 120 ? f.chips : [];
  const n = chips.length;
  const RX = Math.max(R * 1.2, Math.min(R * 1.8, w / 2 - 66));
  const RY = R * 0.43;
  const ry = f.reducedMotion ? 0.5 : t * 0.22;
  const rx = f.reducedMotion ? 0.38 : 0.38 + Math.sin(t * 0.17) * 0.08;
  const [cyR, syR, cxR, sxR] = [Math.cos(ry), Math.sin(ry), Math.cos(rx), Math.sin(rx)];
  const focus = focusIndex(chips, t);
  const focusChip = focus >= 0 ? chips[focus] : undefined;

  const hasRunning = chips.some((c) => c.status === "running") || f.currentState === "working";
  const workPulse = f.reducedMotion
    ? 0
    : hasRunning
      ? 0.34 + 0.14 * Math.sin(t * 5.4)
      : f.currentState === "connecting"
        ? 0.16 + 0.08 * Math.sin(t * 3.4)
        : 0;
  const effLevel = Math.max(f.smoothLevel, workPulse);

  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.6);
  grad.addColorStop(0, rgba(f.currentCol, (palette.isDark ? 0.22 : 0.14) + effLevel * 0.3));
  grad.addColorStop(0.45, rgba(f.currentCol, (palette.isDark ? 0.06 : 0.04) + effLevel * 0.08));
  grad.addColorStop(1, rgba(f.currentCol, 0));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  if (!isDock) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.07);
    ctx.strokeStyle = rgba(palette.secondary, n ? 0.4 : 0.24);
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.ellipse(0, 0, RX, RY, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  const placed = chips.map((c, i) => {
    const text = truncateLabel(c.label, w < 420 ? 22 : 30);
    const cw = Math.min(w - 16, chipWidth(ctx, palette, text));
    const a = f.spin + (i * TAU) / Math.max(1, n);
    const oz = Math.sin(a);
    let x = Math.min(w - cw / 2 - 6, Math.max(cw / 2 + 6, cx + Math.cos(a) * RX));
    let y = cy + oz * RY - Math.cos(a) * R * 0.12;
    const dockTarget = i === focus ? 1 : 0;
    c.dock = f.reducedMotion ? dockTarget : c.dock + (dockTarget - c.dock) * 0.12;
    const d = easeOut(c.dock);
    x += (w - 18 - cw / 2 - x) * d;
    y += (44 - y) * d;
    const k = f.reducedMotion ? 1 : easeOut((t - c.startedAtSec) / LAUNCH_SECONDS);
    const px = cx + (x - cx) * k;
    const py = cy + (y - cy) * k;
    const end = { x: px + (px >= cx ? -cw / 2 : cw / 2), y: py };
    return { c, i, text, cw, z: d > 0.5 ? 1 : oz, x: px, y: py, k, end };
  });

  const drawLayer = (front: boolean) => {
    for (const p of placed) {
      if (p.z > 0 !== front) continue;
      const on = p.i === focus;
      const near = front && !on && Math.abs(p.x - cx) < R * 0.75 + 35;
      const base = w < 420 && !on ? 0.2 : near ? 0.32 : front ? 0.92 : 0.36;
      paintOrbChip(
        ctx,
        palette,
        { x: p.x, y: p.y },
        {
          text: p.text,
          width: p.cw,
          col: chipColor(palette, p.c.status),
          alpha: (on ? 1 : base) * Math.min(1, p.k * 1.5),
          active: on,
        },
      );
    }
  };

  drawLayer(false);

  for (const pt of pts) {
    const wave = f.reducedMotion
      ? 0
      : effLevel * 0.2 * Math.sin(pt.x * 5 + t * 4) * Math.cos(pt.y * 6 - t * 3) +
        0.025 * Math.sin(t * 1.3 + pt.s * TAU);
    const d = 1 + wave;
    const [x, y, z] = [pt.x * d, pt.y * d, pt.z * d];
    const x1 = x * cyR + z * syR;
    const z1 = -x * syR + z * cyR;
    const y2 = y * cxR - z1 * sxR;
    const z2 = y * sxR + z1 * cxR;
    const k = 1.9 / (2.4 - z2 * 0.5);
    const depth = (z2 + 1) / 2;
    const dotCol = mix(f.currentCol, palette.secondary, ((pt.y + 1) / 2) * 0.45);
    const alpha = palette.isDark ? 0.1 + 0.8 * depth * depth : 0.16 + 0.76 * depth * depth;
    ctx.fillStyle = rgba(dotCol, alpha);
    const size = isDock ? 0.7 + depth * 1.1 : 0.6 + depth * 1.5 + (pt.s > 0.97 ? 1.2 : 0);
    ctx.fillRect(cx + x1 * R * k - size / 2, cy + y2 * R * k - size / 2, size, size);
  }

  for (const p of placed) {
    paintOrbTransfer(
      ctx,
      palette,
      { coreX: cx, coreY: cy, toX: p.end.x, toY: p.end.y, radius: R, coreCol: f.currentCol },
      { chip: p.c, t, reducedMotion: f.reducedMotion },
    );
  }

  if (!isDock && R >= 34) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.font = `400 24px ${palette.fontDisplay}`;
    ctx.fillStyle = rgba(palette.text, 0.96);
    ctx.fillText(f.wordmark, cx, cy + 6);
    ctx.font = `600 10px ${palette.fontMono}`;
    ctx.fillStyle = rgba(f.currentCol, 0.96);
    ctx.fillText(f.stateLabel, cx, cy + 25);
    ctx.restore();
  }

  drawLayer(true);

  if (!isDock && w >= 300 && h >= 160) {
    paintBrackets(ctx, palette, w, h);
    paintHud(ctx, palette, f.hudTitle, { x: 20, y: 22, align: "left" }, palette.secondary, 0.85);
    if (!focusChip || focusChip.dock < 0.5)
      paintHud(
        ctx,
        palette,
        f.hudActions,
        { x: w - 20, y: 22, align: "right" },
        palette.secondary,
        0.85,
      );
    const status = focusChip
      ? `${focusChip.status === "running" ? ">" : focusChip.status === "error" ? "x" : "<"} ${truncateLabel(focusChip.label, w < 420 ? 26 : 44)}`
      : f.stateLabel;
    paintHud(
      ctx,
      palette,
      status,
      { x: 20, y: h - 20, align: "left" },
      focusChip ? chipColor(palette, focusChip.status) : f.currentCol,
      0.95,
    );
  }
}
