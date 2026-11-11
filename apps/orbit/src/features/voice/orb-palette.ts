import type { VoiceCallState } from "./types";

export type Rgb = readonly [number, number, number];

export interface SpherePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly s: number;
}

export interface OrbPalette {
  readonly isDark: boolean;
  readonly surface: Rgb;
  readonly text: Rgb;
  readonly muted: Rgb;
  readonly border: Rgb;
  readonly accent: Rgb;
  readonly secondary: Rgb;
  readonly ok: Rgb;
  readonly warn: Rgb;
  readonly info: Rgb;
  readonly danger: Rgb;
  readonly fontDisplay: string;
  readonly fontMono: string;
  readonly fontSans: string;
}

const FALLBACK_LIGHT: OrbPalette = {
  isDark: false,
  surface: [255, 255, 255],
  text: [24, 22, 18],
  muted: [100, 93, 79],
  border: [186, 176, 157],
  accent: [184, 74, 20],
  secondary: [31, 92, 63],
  ok: [25, 103, 62],
  warn: [140, 77, 4],
  info: [23, 92, 211],
  danger: [180, 35, 24],
  fontDisplay: '"Tanker", sans-serif',
  fontMono: '"Azeret Mono", monospace',
  fontSans: '"Switzer", sans-serif',
};

function parseCssColor(raw: string, fallback: Rgb): Rgb {
  const s = raw.trim();
  if (s.startsWith("#")) {
    const hex = s.length === 4 ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}` : s.slice(0, 7);
    if (hex.length === 7) {
      const r = Number.parseInt(hex.slice(1, 3), 16);
      const g = Number.parseInt(hex.slice(3, 5), 16);
      const b = Number.parseInt(hex.slice(5, 7), 16);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return [r, g, b];
    }
  }
  const match = s.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
  if (match?.[1] && match[2] && match[3]) {
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  return fallback;
}

export function readPalette(canvas: HTMLCanvasElement): OrbPalette {
  if (typeof window === "undefined") return FALLBACK_LIGHT;
  const root = canvas.ownerDocument.documentElement;
  const cs = window.getComputedStyle(canvas);
  const isDark = root.getAttribute("data-theme") === "dark";
  return {
    isDark,
    surface: parseCssColor(cs.getPropertyValue("--bg-surface"), FALLBACK_LIGHT.surface),
    text: parseCssColor(cs.getPropertyValue("--text-primary"), FALLBACK_LIGHT.text),
    muted: parseCssColor(cs.getPropertyValue("--text-muted"), FALLBACK_LIGHT.muted),
    border: parseCssColor(cs.getPropertyValue("--border-strong"), FALLBACK_LIGHT.border),
    accent: parseCssColor(cs.getPropertyValue("--accent-primary"), FALLBACK_LIGHT.accent),
    secondary: parseCssColor(cs.getPropertyValue("--accent-secondary"), FALLBACK_LIGHT.secondary),
    ok: parseCssColor(cs.getPropertyValue("--status-ok"), FALLBACK_LIGHT.ok),
    warn: parseCssColor(cs.getPropertyValue("--status-warn"), FALLBACK_LIGHT.warn),
    info: parseCssColor(cs.getPropertyValue("--status-info"), FALLBACK_LIGHT.info),
    danger: parseCssColor(cs.getPropertyValue("--status-danger"), FALLBACK_LIGHT.danger),
    fontDisplay: cs.getPropertyValue("--font-display").trim() || FALLBACK_LIGHT.fontDisplay,
    fontMono: cs.getPropertyValue("--font-mono").trim() || FALLBACK_LIGHT.fontMono,
    fontSans: cs.getPropertyValue("--font-sans").trim() || FALLBACK_LIGHT.fontSans,
  };
}

export function rgba(c: Rgb, a: number): string {
  return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function easeOut(x: number): number {
  return 1 - (1 - Math.min(1, Math.max(0, x))) ** 3;
}

export function stateColor(state: VoiceCallState, p: OrbPalette): Rgb {
  switch (state) {
    case "connecting":
      return p.warn;
    case "listening":
      return p.ok;
    case "working":
      return p.accent;
    case "speaking":
      return p.info;
    case "idle":
    case "ended":
      return mix(p.muted, p.accent, 0.22);
  }
}

export function buildSphere(count: number): SpherePoint[] {
  const pts: SpherePoint[] = [];
  let seed = 7;
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (i / Math.max(1, count - 1)) * 2;
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const th = i * 2.399963;
    pts.push({ x: Math.cos(th) * rad, y, z: Math.sin(th) * rad, s: rnd() });
  }
  return pts;
}

export function truncateLabel(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trimEnd()}…`;
}
