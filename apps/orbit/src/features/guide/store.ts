import type { GuideVisualState, Point } from "./types";

export interface GuideHost {
  readonly navigate: (path: string) => void;
  readonly getPath: () => string;
}

export interface StoredRefTarget {
  readonly element: Element;
  readonly label: string;
}

const INITIAL_VISUAL_STATE: GuideVisualState = {
  mode: "idle",
  targetElement: null,
  targetLabel: "",
  note: undefined,
  pointerPhase: "idle",
  pointerFrom: null,
  pointerTo: null,
  routePath: "/",
  sequence: 0,
};

let activeHost: GuideHost | null = null;
let visualState: GuideVisualState = INITIAL_VISUAL_STATE;
let latestRefs = new Map<number, StoredRefTarget>();
let lastPointerPoint: Point | null = null;
let suppressDismissClick = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeGuideState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getGuideVisualState(): GuideVisualState {
  return visualState;
}

export function updateGuideVisualState(
  patch: Omit<GuideVisualState, "sequence">,
): GuideVisualState {
  visualState = {
    ...patch,
    sequence: visualState.sequence + 1,
  };
  emit();
  return visualState;
}

export function getActiveGuideHost(): GuideHost | null {
  return activeHost;
}

export function registerGuideHost(host: GuideHost): () => void {
  activeHost = host;
  return () => {
    if (activeHost === host) {
      activeHost = null;
      latestRefs.clear();
      lastPointerPoint = null;
      visualState = INITIAL_VISUAL_STATE;
      emit();
    }
  };
}

export function setLatestRefs(next: Map<number, StoredRefTarget>): void {
  latestRefs = next;
}

export function getStoredRef(ref: number): StoredRefTarget | undefined {
  return latestRefs.get(ref);
}

export function getLastPointerPoint(): Point | null {
  return lastPointerPoint;
}

export function setLastPointerPoint(point: Point | null): void {
  lastPointerPoint = point;
}

export function isSuppressingDismissClick(): boolean {
  return suppressDismissClick;
}

export function withSuppressedDismissClick(fn: () => void): void {
  suppressDismissClick = true;
  try {
    fn();
  } finally {
    suppressDismissClick = false;
  }
}

export function dismissGuideOverlay(): void {
  if (visualState.mode === "idle") return;
  updateGuideVisualState({
    ...INITIAL_VISUAL_STATE,
    routePath: activeHost?.getPath() ?? "/",
  });
}
