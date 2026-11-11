import type { BoxRect, Point } from "./types";

const VIEWPORT_MARGIN = 12;
const RING_PAD = 4;
const NOTE_GAP = 10;
const POINTER_SIZE = 28;

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface OverlayPlacement {
  readonly ring: BoxRect;
  readonly pointer: Point;
  readonly note: {
    readonly left: number;
    readonly top: number;
    readonly maxWidth: number;
  };
}

export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export function computeOverlayPlacement(
  target: BoxRect,
  noteSize: { readonly width: number; readonly height: number },
  viewport: ViewportSize,
): OverlayPlacement {
  const vw = Math.max(viewport.width, 320);
  const vh = Math.max(viewport.height, 240);

  const rawLeft = target.left - RING_PAD;
  const rawTop = target.top - RING_PAD;
  const rawWidth = Math.max(target.width + RING_PAD * 2, 24);
  const rawHeight = Math.max(target.height + RING_PAD * 2, 24);

  const ringWidth = Math.min(rawWidth, Math.max(24, vw - VIEWPORT_MARGIN * 2));
  const ringHeight = Math.min(rawHeight, Math.max(24, vh - VIEWPORT_MARGIN * 2));
  const ringLeft = clamp(rawLeft, VIEWPORT_MARGIN, vw - VIEWPORT_MARGIN - ringWidth);
  const ringTop = clamp(rawTop, VIEWPORT_MARGIN, vh - VIEWPORT_MARGIN - ringHeight);

  const ring: BoxRect = {
    left: ringLeft,
    top: ringTop,
    width: ringWidth,
    height: ringHeight,
  };

  const pointerX = clamp(
    ring.left + Math.min(ring.width * 0.72, ring.width - 6),
    VIEWPORT_MARGIN,
    vw - VIEWPORT_MARGIN - POINTER_SIZE,
  );
  const pointerY = clamp(
    ring.top + Math.min(ring.height * 0.68, ring.height - 6),
    VIEWPORT_MARGIN,
    vh - VIEWPORT_MARGIN - POINTER_SIZE,
  );

  const maxNoteWidth = Math.min(320, vw - VIEWPORT_MARGIN * 2);
  const estWidth = Math.min(Math.max(noteSize.width, 180), maxNoteWidth);
  const estHeight = Math.max(noteSize.height, 44);

  const spaceBelow = vh - (ring.top + ring.height) - VIEWPORT_MARGIN;
  const spaceAbove = ring.top - VIEWPORT_MARGIN;
  const spaceRight = vw - (ring.left + ring.width) - VIEWPORT_MARGIN;

  let noteTop: number;
  let noteLeft: number;

  if (spaceBelow >= estHeight + NOTE_GAP || spaceBelow >= spaceAbove) {
    noteTop = clamp(
      ring.top + ring.height + NOTE_GAP,
      VIEWPORT_MARGIN,
      vh - VIEWPORT_MARGIN - estHeight,
    );
    noteLeft = clamp(ring.left, VIEWPORT_MARGIN, vw - VIEWPORT_MARGIN - estWidth);
  } else if (spaceAbove >= estHeight + NOTE_GAP) {
    noteTop = clamp(
      ring.top - estHeight - NOTE_GAP,
      VIEWPORT_MARGIN,
      vh - VIEWPORT_MARGIN - estHeight,
    );
    noteLeft = clamp(ring.left, VIEWPORT_MARGIN, vw - VIEWPORT_MARGIN - estWidth);
  } else if (spaceRight >= estWidth + NOTE_GAP) {
    noteLeft = clamp(
      ring.left + ring.width + NOTE_GAP,
      VIEWPORT_MARGIN,
      vw - VIEWPORT_MARGIN - estWidth,
    );
    noteTop = clamp(ring.top, VIEWPORT_MARGIN, vh - VIEWPORT_MARGIN - estHeight);
  } else {
    noteLeft = clamp(ring.left, VIEWPORT_MARGIN, vw - VIEWPORT_MARGIN - estWidth);
    noteTop = clamp(vh - VIEWPORT_MARGIN - estHeight, VIEWPORT_MARGIN, vh - VIEWPORT_MARGIN);
  }

  return {
    ring,
    pointer: { x: pointerX, y: pointerY },
    note: {
      left: noteLeft,
      top: noteTop,
      maxWidth: maxNoteWidth,
    },
  };
}

export interface ScaledBrowserHighlight {
  readonly style: {
    readonly left: string;
    readonly top: string;
    readonly width: string;
    readonly height: string;
  };
  readonly notePosition: "above" | "below";
  readonly noteAlign: "start" | "end";
}

export function computeScaledBrowserHighlight(
  picture: { readonly width: number; readonly height: number },
  highlight: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  rendered: {
    readonly offsetX: number;
    readonly offsetY: number;
    readonly width: number;
    readonly height: number;
  } | null,
): ScaledBrowserHighlight {
  const picW = Math.max(picture.width, 1);
  const picH = Math.max(picture.height, 1);

  if (rendered && rendered.width > 0 && rendered.height > 0) {
    const scaleX = rendered.width / picW;
    const scaleY = rendered.height / picH;
    const rawLeft = highlight.x * scaleX;
    const rawTop = highlight.y * scaleY;
    const width = clamp(highlight.width * scaleX, 8, rendered.width);
    const height = clamp(highlight.height * scaleY, 8, rendered.height);
    const left = rendered.offsetX + clamp(rawLeft, 0, Math.max(0, rendered.width - width));
    const top = rendered.offsetY + clamp(rawTop, 0, Math.max(0, rendered.height - height));
    const spaceBelow = rendered.offsetY + rendered.height - (top + height);
    return {
      style: {
        left: `${Math.round(left * 100) / 100}px`,
        top: `${Math.round(top * 100) / 100}px`,
        width: `${Math.round(width * 100) / 100}px`,
        height: `${Math.round(height * 100) / 100}px`,
      },
      notePosition: spaceBelow >= 64 ? "below" : "above",
      noteAlign: rawLeft > rendered.width * 0.5 ? "end" : "start",
    };
  }

  const pctLeft = clamp((highlight.x / picW) * 100, 0, 100);
  const pctTop = clamp((highlight.y / picH) * 100, 0, 100);
  const pctWidth = clamp((highlight.width / picW) * 100, 1, 100 - pctLeft);
  const pctHeight = clamp((highlight.height / picH) * 100, 1, 100 - pctTop);
  return {
    style: {
      left: `${Math.round(pctLeft * 100) / 100}%`,
      top: `${Math.round(pctTop * 100) / 100}%`,
      width: `${Math.round(pctWidth * 100) / 100}%`,
      height: `${Math.round(pctHeight * 100) / 100}%`,
    },
    notePosition: pctTop + pctHeight <= 78 ? "below" : "above",
    noteAlign: pctLeft > 50 ? "end" : "start",
  };
}
