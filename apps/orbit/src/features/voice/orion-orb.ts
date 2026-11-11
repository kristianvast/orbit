import { buildSphere, mix, type Rgb, readPalette, stateColor } from "./orb-palette";
import { drawOrbScene, type OrbVariant, type TrackedChip } from "./orion-orb-draw";
import type { ActivityRowView, VoiceCallState } from "./types";

export type { OrbVariant } from "./orion-orb-draw";

const MAX_CHIPS = 4;

export interface OrionOrbController {
  update(input: {
    readonly state: VoiceCallState;
    readonly stateLabel: string;
    readonly wordmark: string;
    readonly level: number;
    readonly activities: readonly ActivityRowView[];
    readonly reducedMotion: boolean;
  }): void;
  refreshTheme(): void;
  destroy(): void;
}

export function createOrionOrb(
  canvas: HTMLCanvasElement,
  variant: OrbVariant,
): OrionOrbController | null {
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) {
    return null;
  }
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    return null;
  }
  if (!ctx) return null;
  const context = ctx;

  const pts = buildSphere(variant === "dock" ? 220 : variant === "widget" ? 560 : 780);
  let palette = readPalette(canvas);
  let currentState: VoiceCallState = "idle";
  let stateLabel = "READY";
  let wordmark = "ORION";
  let targetLevel = 0;
  let smoothLevel = 0;
  let reducedMotion = false;
  let currentCol: Rgb = stateColor("idle", palette);
  let chips: TrackedChip[] = [];
  let spin = 0;
  let w = 0;
  let h = 0;
  let dpr = 1;
  let visible = true;
  let raf = 0;
  let lastSec = 0;
  const t0 = typeof performance !== "undefined" ? performance.now() : 0;
  const nowSec = () => ((typeof performance !== "undefined" ? performance.now() : 0) - t0) / 1000;

  const paint = (t: number) =>
    drawOrbScene({
      ctx: context,
      palette,
      pts,
      variant,
      w,
      h,
      dpr,
      t,
      spin,
      smoothLevel,
      currentCol,
      currentState,
      stateLabel,
      wordmark,
      reducedMotion,
      chips,
    });

  function tick(): void {
    raf = 0;
    const t = nowSec();
    const dt = Math.min(0.05, lastSec ? t - lastSec : 0.016);
    lastSec = t;
    smoothLevel += (targetLevel - smoothLevel) * (targetLevel > smoothLevel ? 0.35 : 0.09);
    currentCol = mix(currentCol, stateColor(currentState, palette), 0.14);
    const busy = currentState === "working" || chips.some((c) => c.status === "running");
    spin += dt * (busy ? 0.42 : 0.2);
    paint(t);
    if (
      !reducedMotion &&
      visible &&
      !canvas.ownerDocument.hidden &&
      (currentState !== "idle" || smoothLevel > 0.01 || chips.length > 0)
    ) {
      raf = window.requestAnimationFrame(tick);
    }
  }

  function kick(): void {
    if (reducedMotion || currentState === "idle") {
      smoothLevel = reducedMotion ? 0 : targetLevel;
      currentCol = stateColor(currentState, palette);
      if (raf) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
      paint(nowSec());
      return;
    }
    if (!raf && visible && !canvas.ownerDocument.hidden) {
      lastSec = 0;
      raf = window.requestAnimationFrame(tick);
    }
  }

  function resize(): void {
    const rect = canvas.getBoundingClientRect();
    dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
    w = rect.width || (variant === "dock" ? 40 : 260);
    h = rect.height || (variant === "dock" ? 40 : variant === "widget" ? 148 : 210);
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    paint(nowSec());
  }

  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
  ro?.observe(canvas);
  const io =
    typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver((entries) => {
          visible = entries.some((e) => e.isIntersecting);
          kick();
        })
      : null;
  io?.observe(canvas);
  const doc = canvas.ownerDocument;
  const refreshPalette = () => {
    palette = readPalette(canvas);
    currentCol = stateColor(currentState, palette);
    paint(nowSec());
    kick();
  };
  const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(refreshPalette) : null;
  mo?.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  doc.addEventListener("visibilitychange", kick);
  resize();

  return {
    update(next) {
      currentState = next.state;
      stateLabel = next.stateLabel;
      wordmark = next.wordmark;
      reducedMotion = next.reducedMotion;
      targetLevel = next.reducedMotion ? 0 : Math.max(0, Math.min(1, next.level));
      const t = nowSec();
      chips = next.activities.slice(-MAX_CHIPS).map((act) => {
        const prev = chips.find((c) => c.id === act.id);
        if (!prev) {
          return {
            id: act.id,
            label: act.chipLabel,
            status: act.status,
            startedAtSec: t,
            endedAtSec: act.status === "running" ? Number.POSITIVE_INFINITY : t,
          };
        }
        return {
          ...prev,
          label: act.chipLabel,
          status: act.status,
          endedAtSec: prev.status === "running" && act.status !== "running" ? t : prev.endedAtSec,
        };
      });
      kick();
    },
    refreshTheme: refreshPalette,
    destroy() {
      if (raf) window.cancelAnimationFrame(raf);
      ro?.disconnect();
      io?.disconnect();
      mo?.disconnect();
      doc.removeEventListener("visibilitychange", kick);
    },
  };
}
