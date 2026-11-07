import { useEffect, useMemo, useState } from "react";
import { type OrionEndpoint, useOrion } from "../../../lib/orion";
import { buildCameraSnapshotUrl } from "../lib/stream";

export const SNAPSHOT_REFRESH_MS = 12_000;
export const SNAPSHOT_STAGGER_MS = 400;

export function cameraSnapshotUrl(
  endpoint: OrionEndpoint | null | undefined,
  cameraId: string,
  token?: number,
): string {
  return buildCameraSnapshotUrl(endpoint, cameraId, token);
}

export function prefetchCameraSnapshot(
  endpoint: OrionEndpoint | null | undefined,
  cameraId: string | undefined | null,
): void {
  if (!cameraId || typeof Image === "undefined") return;
  const src = cameraSnapshotUrl(endpoint, cameraId);
  if (!src) return;
  const img = new Image();
  img.decoding = "async";
  img.src = src;
}

export type CameraSnapshotOptions = {
  readonly refreshMs?: number;
  readonly enabled?: boolean;
  readonly staggerMs?: number;
};

export function useCameraSnapshot(cameraId: string, options: CameraSnapshotOptions = {}): string {
  const { endpoint } = useOrion();
  const { refreshMs = 0, enabled = true, staggerMs = 0 } = options;
  const [refreshed, setRefreshed] = useState<{
    readonly cameraId: string;
    readonly token: number;
  } | null>(null);

  const token = refreshed?.cameraId === cameraId ? refreshed.token : undefined;

  useEffect(() => {
    if (!enabled || refreshMs <= 0 || !cameraId || !endpoint) return;

    const bump = () => setRefreshed({ cameraId, token: Date.now() });
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const startId = window.setTimeout(() => {
      bump();
      intervalId = setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        bump();
      }, refreshMs);
    }, staggerMs);

    return () => {
      window.clearTimeout(startId);
      if (intervalId) clearInterval(intervalId);
    };
  }, [enabled, refreshMs, staggerMs, cameraId, endpoint]);

  return useMemo(() => {
    if (!enabled) return "";
    return cameraSnapshotUrl(endpoint, cameraId, token);
  }, [enabled, endpoint, cameraId, token]);
}
