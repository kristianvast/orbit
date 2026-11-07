import type { CameraMapLayout, CameraMapTile } from "@orbit/protocol";

export type CameraIdentity = {
  readonly id: string;
};

export const DEFAULT_CAMERA_AR = 896 / 512;
export const DEFAULT_TILE_W = 480;
export const TILE_MARGIN = 24;
export const GRID_SIZE = 20;
export const SIZE_PRESETS = [240, 360, 480, 640, 800] as const;
export const SNAP_THRESHOLD = 10;
export const MIN_TILE_W = 240;

export function snapToGrid(v: number): number {
  return Math.round(v / GRID_SIZE) * GRID_SIZE;
}

export function snapWidth(rawW: number, neighborWidths: readonly number[]): number {
  const candidates = [...SIZE_PRESETS, ...neighborWidths];
  let best: number = SIZE_PRESETS[0];
  let minDiff = Math.abs(rawW - best);
  for (const c of candidates) {
    const diff = Math.abs(rawW - c);
    if (diff < minDiff) {
      best = c;
      minDiff = diff;
    }
  }
  return Math.max(MIN_TILE_W, best);
}

function packCameras(cameras: readonly CameraIdentity[], baseY = 0): CameraMapTile[] {
  const perRow = 3;
  return cameras.map((cam, idx) => {
    const row = Math.floor(idx / perRow);
    const col = idx % perRow;
    return {
      i: cam.id,
      x: col * (DEFAULT_TILE_W + TILE_MARGIN),
      y: baseY + row * (DEFAULT_TILE_W / DEFAULT_CAMERA_AR + TILE_MARGIN),
      w: DEFAULT_TILE_W,
      ar: DEFAULT_CAMERA_AR,
    };
  });
}

export function buildDefaultLayouts(cameras: readonly CameraIdentity[]): CameraMapLayout {
  if (cameras.length === 0) return { version: 2, tiles: [] };
  return {
    version: 2,
    tiles: packCameras(cameras, 0),
  };
}

function isCameraMapLayout(stored: unknown): stored is CameraMapLayout {
  if (!stored || typeof stored !== "object") return false;
  const candidate = stored as { version?: unknown; tiles?: unknown };
  return candidate.version === 2 && Array.isArray(candidate.tiles);
}

export function reconcileLayouts(
  cameras: readonly CameraIdentity[],
  stored: unknown,
): CameraMapLayout {
  if (cameras.length === 0) return { version: 2, tiles: [] };
  if (!isCameraMapLayout(stored)) {
    return buildDefaultLayouts(cameras);
  }

  const ids = new Set(cameras.map((c) => c.id));
  const kept = stored.tiles.filter(
    (item) =>
      item &&
      typeof item.i === "string" &&
      ids.has(item.i) &&
      typeof item.x === "number" &&
      typeof item.y === "number" &&
      typeof item.w === "number" &&
      item.w > 0,
  );
  const keptIds = new Set(kept.map((item) => item.i));
  const missing = cameras.filter((cam) => !keptIds.has(cam.id));

  if (missing.length === 0) {
    return { version: 2, tiles: kept };
  }

  const baseY = kept.reduce((maxBottom, item) => {
    const h = item.w / (item.ar || DEFAULT_CAMERA_AR);
    return Math.max(maxBottom, item.y + h + TILE_MARGIN);
  }, 0);

  return {
    version: 2,
    tiles: [...kept, ...packCameras(missing, baseY)],
  };
}

export type SnappedMoveResult = {
  readonly x: number;
  readonly y: number;
  readonly guideX: number | null;
  readonly guideY: number | null;
};

export function computeSnappedMove(params: {
  readonly id: string;
  readonly rawX: number;
  readonly rawY: number;
  readonly width: number;
  readonly height: number;
  readonly tiles: readonly CameraMapTile[];
}): SnappedMoveResult {
  let nextX = params.rawX;
  let nextY = params.rawY;
  let guideX: number | null = null;
  let guideY: number | null = null;

  for (const other of params.tiles) {
    if (other.i === params.id) continue;
    const otherW = other.w;
    const otherH = otherW / (other.ar || DEFAULT_CAMERA_AR);

    if (guideX === null) {
      const edges = [nextX, nextX + params.width / 2, nextX + params.width] as const;
      const otherEdges = [other.x, other.x + otherW / 2, other.x + otherW] as const;
      for (const edge of edges) {
        for (const otherEdge of otherEdges) {
          if (Math.abs(edge - otherEdge) < SNAP_THRESHOLD) {
            nextX += otherEdge - edge;
            guideX = otherEdge;
            break;
          }
        }
        if (guideX !== null) break;
      }
    }

    if (guideY === null) {
      const edges = [nextY, nextY + params.height / 2, nextY + params.height] as const;
      const otherEdges = [other.y, other.y + otherH / 2, other.y + otherH] as const;
      for (const edge of edges) {
        for (const otherEdge of otherEdges) {
          if (Math.abs(edge - otherEdge) < SNAP_THRESHOLD) {
            nextY += otherEdge - edge;
            guideY = otherEdge;
            break;
          }
        }
        if (guideY !== null) break;
      }
    }
  }

  return {
    x: guideX === null ? snapToGrid(nextX) : nextX,
    y: guideY === null ? snapToGrid(nextY) : nextY,
    guideX,
    guideY,
  };
}
