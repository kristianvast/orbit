import type { CameraMapLayout, CameraMapTile } from "@orbit/protocol";
import type { Camera as CameraRow } from "@orbit/schema";
import { type PointerEvent as ReactPointerEvent, type RefObject, useCallback, useRef } from "react";
import {
  buildDefaultLayouts,
  computeSnappedMove,
  DEFAULT_CAMERA_AR,
  MIN_TILE_W,
  SNAP_THRESHOLD,
  snapWidth,
} from "../lib/default-layout";
import type { ViewportState } from "./useBarnMapViewport";

type ActiveGesture = {
  id: string;
  type: "move" | "resize";
  pointerId: number;
  startX: number;
  startY: number;
  startW: number;
  startTileX: number;
  startTileY: number;
  hasMoved: boolean;
};

export interface UseBarnMapTileGesturesParams {
  readonly cameras: readonly CameraRow[];
  readonly layout: CameraMapLayout;
  readonly storedLayouts: CameraMapLayout | null;
  readonly saveLayouts: (layout: CameraMapLayout) => void;
  readonly stateRef: RefObject<ViewportState>;
}

export function useBarnMapTileGestures({
  cameras,
  layout,
  storedLayouts,
  saveLayouts,
  stateRef,
}: UseBarnMapTileGesturesParams) {
  const activeTileRef = useRef<ActiveGesture | null>(null);
  const rafRef = useRef<number | null>(null);
  const vGuideRef = useRef<HTMLDivElement>(null);
  const hGuideRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, tile: CameraMapTile) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      if (!(e.currentTarget as HTMLElement).contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest("[data-no-drag]")) return;

      const isResize = Boolean((e.target as HTMLElement).closest("[data-resize-handle]"));
      const el = e.currentTarget;
      delete el.dataset.justDragged;

      activeTileRef.current = {
        id: tile.i,
        type: isResize ? "resize" : "move",
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startW: tile.w,
        startTileX: tile.x,
        startTileY: tile.y,
        hasMoved: isResize,
      };

      if (isResize) {
        el.setPointerCapture?.(e.pointerId);
        if (gridRef.current) gridRef.current.style.opacity = "1";
      }
      e.stopPropagation();
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = activeTileRef.current;
      if (!gesture) return;

      const dx = e.clientX - gesture.startX;
      const dy = e.clientY - gesture.startY;
      const zoom = stateRef.current.zoom;
      const tileEl = e.currentTarget;

      if (gesture.type === "move") {
        if (!gesture.hasMoved && Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        if (!gesture.hasMoved) {
          gesture.hasMoved = true;
          tileEl.dataset.justDragged = "true";
          tileEl.setPointerCapture?.(gesture.pointerId);
          if (gridRef.current) gridRef.current.style.opacity = "1";
        }

        const tile = layout.tiles.find((item) => item.i === gesture.id);
        const ar = tile?.ar || DEFAULT_CAMERA_AR;
        const w = gesture.startW;
        const snapped = computeSnappedMove({
          id: gesture.id,
          rawX: gesture.startTileX + dx / zoom,
          rawY: gesture.startTileY + dy / zoom,
          width: w,
          height: w / ar,
          tiles: layout.tiles,
        });

        if (!rafRef.current) {
          rafRef.current = requestAnimationFrame(() => {
            tileEl.style.left = `${snapped.x}px`;
            tileEl.style.top = `${snapped.y}px`;
            if (vGuideRef.current) {
              vGuideRef.current.style.display = snapped.guideX !== null ? "block" : "none";
              if (snapped.guideX !== null) vGuideRef.current.style.left = `${snapped.guideX}px`;
            }
            if (hGuideRef.current) {
              hGuideRef.current.style.display = snapped.guideY !== null ? "block" : "none";
              if (snapped.guideY !== null) hGuideRef.current.style.top = `${snapped.guideY}px`;
            }
            rafRef.current = null;
          });
        }
      } else {
        let rawW = Math.max(MIN_TILE_W, gesture.startW + dx / zoom);
        const tile = layout.tiles.find((item) => item.i === gesture.id);
        const ar = tile?.ar || DEFAULT_CAMERA_AR;
        const neighborWidths = layout.tiles
          .filter((item) => item.i !== gesture.id)
          .map((item) => item.w);
        const cleanW = snapWidth(rawW, neighborWidths);
        if (Math.abs(rawW - cleanW) < SNAP_THRESHOLD) rawW = cleanW;
        const newH = rawW / ar;

        if (!rafRef.current) {
          rafRef.current = requestAnimationFrame(() => {
            tileEl.style.width = `${rawW}px`;
            tileEl.style.height = `${newH}px`;
            rafRef.current = null;
          });
        }
      }
    },
    [layout.tiles, stateRef],
  );

  const finishGesture = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (vGuideRef.current) vGuideRef.current.style.display = "none";
      if (hGuideRef.current) hGuideRef.current.style.display = "none";
      if (gridRef.current) gridRef.current.style.opacity = "0";

      const gesture = activeTileRef.current;
      if (!gesture) return;
      activeTileRef.current = null;

      if (gesture.hasMoved) {
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }
      if (gesture.type === "move" && !gesture.hasMoved) return;

      const dx = e.clientX - gesture.startX;
      const dy = e.clientY - gesture.startY;
      const zoom = stateRef.current.zoom;

      const newTiles = layout.tiles.map((tItem) => {
        if (tItem.i !== gesture.id) return tItem;
        if (gesture.type === "move") {
          const ar = tItem.ar || DEFAULT_CAMERA_AR;
          const snapped = computeSnappedMove({
            id: gesture.id,
            rawX: gesture.startTileX + dx / zoom,
            rawY: gesture.startTileY + dy / zoom,
            width: gesture.startW,
            height: gesture.startW / ar,
            tiles: layout.tiles,
          });
          return { ...tItem, x: snapped.x, y: snapped.y };
        }
        const rawW = Math.max(MIN_TILE_W, gesture.startW + dx / zoom);
        const neighborWidths = layout.tiles
          .filter((other) => other.i !== gesture.id)
          .map((other) => other.w);
        return { ...tItem, w: snapWidth(rawW, neighborWidths) };
      });

      const visibleIds = new Set(cameras.map((c) => c.id));
      const tilesFromOtherBarns = (storedLayouts?.tiles ?? []).filter(
        (tItem) => !visibleIds.has(tItem.i),
      );
      saveLayouts({ version: 2, tiles: [...tilesFromOtherBarns, ...newTiles] });
    },
    [cameras, layout.tiles, saveLayouts, stateRef, storedLayouts],
  );

  const handleTidyUp = useCallback(() => {
    const arById = new Map(layout.tiles.map((tItem) => [tItem.i, tItem.ar]));
    const newTiles = buildDefaultLayouts(cameras).tiles.map((tItem) => ({
      ...tItem,
      ar: arById.get(tItem.i) ?? tItem.ar,
    }));
    const visibleIds = new Set(cameras.map((c) => c.id));
    const tilesFromOtherBarns = (storedLayouts?.tiles ?? []).filter(
      (tItem) => !visibleIds.has(tItem.i),
    );
    saveLayouts({ version: 2, tiles: [...tilesFromOtherBarns, ...newTiles] });
  }, [cameras, layout.tiles, saveLayouts, storedLayouts]);

  return {
    vGuideRef,
    hGuideRef,
    gridRef,
    handlePointerDown,
    handlePointerMove,
    finishGesture,
    handleTidyUp,
  };
}
