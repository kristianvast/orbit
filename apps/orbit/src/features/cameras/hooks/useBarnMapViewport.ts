import { useCallback, useEffect, useRef } from "react";

export type ViewportState = {
  panX: number;
  panY: number;
  zoom: number;
};

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const DEFAULT_PAN_PADDING = 20;

function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

function storageKeyFor(farmId: string): string {
  return `orbit_barn_map_viewport_${farmId || "default"}`;
}

export function useBarnMapViewport(farmId: string) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<ViewportState>({
    panX: DEFAULT_PAN_PADDING,
    panY: DEFAULT_PAN_PADDING,
    zoom: 1,
  });
  const rafRef = useRef<number | null>(null);

  const applyTransform = useCallback(() => {
    if (containerRef.current) {
      const { panX, panY, zoom } = stateRef.current;
      containerRef.current.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    }
  }, []);

  const saveState = useCallback(() => {
    try {
      localStorage.setItem(storageKeyFor(farmId), JSON.stringify(stateRef.current));
    } catch (err) {
      if (!(err instanceof Error)) throw err;
    }
  }, [farmId]);

  const computeInitialViewport = useCallback((): ViewportState => {
    const width = containerRef.current?.parentElement?.clientWidth ?? 0;
    if (width > 0 && width < 520) {
      return { panX: 12, panY: 12, zoom: clampZoom(Number(((width - 24) / 480).toFixed(2))) };
    }
    return { panX: DEFAULT_PAN_PADDING, panY: DEFAULT_PAN_PADDING, zoom: 1 };
  }, []);

  const resetViewport = useCallback(() => {
    stateRef.current = computeInitialViewport();
    applyTransform();
    saveState();
  }, [applyTransform, computeInitialViewport, saveState]);

  useEffect(() => {
    let loaded = false;
    try {
      const saved = localStorage.getItem(storageKeyFor(farmId));
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<ViewportState>;
        if (
          typeof parsed.panX === "number" &&
          typeof parsed.panY === "number" &&
          typeof parsed.zoom === "number"
        ) {
          stateRef.current = {
            panX: parsed.panX,
            panY: parsed.panY,
            zoom: clampZoom(parsed.zoom),
          };
          loaded = true;
        }
      }
    } catch (err) {
      if (!(err instanceof Error)) throw err;
    }
    if (!loaded) stateRef.current = computeInitialViewport();
    applyTransform();
  }, [farmId, applyTransform, computeInitialViewport]);

  useEffect(() => {
    const container = containerRef.current;
    const parent = container?.parentElement;
    if (!container || !parent) return;

    let isPanning = false;
    let startX = 0;
    let startY = 0;
    let initialPanX = 0;
    let initialPanY = 0;
    let initialPinchDistance = 0;
    let initialZoom = 1;
    let pinchCenter = { x: 0, y: 0 };
    let wheelTimer: ReturnType<typeof setTimeout> | null = null;
    const activePointers = new Map<number, PointerEvent>();

    const isBackground = (t: EventTarget | null): boolean =>
      t === parent ||
      t === container ||
      (t instanceof HTMLElement && t.dataset.barnCanvasBg === "true");

    const scheduleTransform = () => {
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(() => {
          applyTransform();
          rafRef.current = null;
        });
      }
    };

    const handlePointerDown = (e: PointerEvent) => {
      if (isBackground(e.target) || e.pointerType === "touch") {
        activePointers.set(e.pointerId, e);
      }
      if (activePointers.size === 1 && isBackground(e.target)) {
        isPanning = true;
        startX = e.clientX;
        startY = e.clientY;
        initialPanX = stateRef.current.panX;
        initialPanY = stateRef.current.panY;
        parent.setPointerCapture?.(e.pointerId);
        container.style.willChange = "transform";
      } else if (activePointers.size === 2) {
        isPanning = false;
        const [p0, p1] = Array.from(activePointers.values());
        if (!p0 || !p1) return;
        initialPinchDistance = Math.hypot(p0.clientX - p1.clientX, p0.clientY - p1.clientY);
        initialZoom = stateRef.current.zoom;
        pinchCenter = {
          x: (p0.clientX + p1.clientX) / 2,
          y: (p0.clientY + p1.clientY) / 2,
        };
        container.style.willChange = "transform";
      }
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, e);
      if (isPanning && activePointers.size === 1) {
        stateRef.current.panX = initialPanX + (e.clientX - startX);
        stateRef.current.panY = initialPanY + (e.clientY - startY);
        scheduleTransform();
      } else if (activePointers.size === 2 && initialPinchDistance > 0) {
        const [p0, p1] = Array.from(activePointers.values());
        if (!p0 || !p1) return;
        const distance = Math.hypot(p0.clientX - p1.clientX, p0.clientY - p1.clientY);
        const newZoom = clampZoom(initialZoom * (distance / initialPinchDistance));
        const rect = parent.getBoundingClientRect();
        const cx = pinchCenter.x - rect.left;
        const cy = pinchCenter.y - rect.top;
        const zoomRatio = newZoom / stateRef.current.zoom;
        stateRef.current.panX = cx - (cx - stateRef.current.panX) * zoomRatio;
        stateRef.current.panY = cy - (cy - stateRef.current.panY) * zoomRatio;
        stateRef.current.zoom = newZoom;
        scheduleTransform();
      }
    };

    const handlePointerUp = (e: PointerEvent) => {
      activePointers.delete(e.pointerId);
      if (activePointers.size === 0 && isPanning) {
        isPanning = false;
        container.style.willChange = "auto";
        saveState();
      } else if (activePointers.size === 1) {
        const remaining = Array.from(activePointers.values())[0];
        if (remaining) {
          isPanning = true;
          startX = remaining.clientX;
          startY = remaining.clientY;
          initialPanX = stateRef.current.panX;
          initialPanY = stateRef.current.panY;
        }
      }
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = parent.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const newZoom = clampZoom(stateRef.current.zoom * (1 + e.deltaY * -0.001));
      const zoomRatio = newZoom / stateRef.current.zoom;
      stateRef.current.panX = cx - (cx - stateRef.current.panX) * zoomRatio;
      stateRef.current.panY = cy - (cy - stateRef.current.panY) * zoomRatio;
      stateRef.current.zoom = newZoom;
      container.style.willChange = "transform";
      applyTransform();
      if (wheelTimer) clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => {
        container.style.willChange = "auto";
        saveState();
      }, 200);
    };

    parent.addEventListener("pointerdown", handlePointerDown);
    parent.addEventListener("pointermove", handlePointerMove);
    parent.addEventListener("pointerup", handlePointerUp);
    parent.addEventListener("pointercancel", handlePointerUp);
    parent.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      parent.removeEventListener("pointerdown", handlePointerDown);
      parent.removeEventListener("pointermove", handlePointerMove);
      parent.removeEventListener("pointerup", handlePointerUp);
      parent.removeEventListener("pointercancel", handlePointerUp);
      parent.removeEventListener("wheel", handleWheel);
      if (wheelTimer) clearTimeout(wheelTimer);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [applyTransform, saveState]);

  return { containerRef, stateRef, resetViewport };
}
