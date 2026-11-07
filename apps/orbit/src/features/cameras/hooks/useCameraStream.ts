import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useOrion } from "../../../lib/orion";
import { buildCameraWsUrl, connectMSE, type MseSession, type MseStats } from "../lib/stream";

export type CameraStreamOptions = {
  readonly enabled?: boolean;
  readonly pauseWhenOffscreen?: boolean;
  readonly pauseWhenHidden?: boolean;
  readonly intersectionThreshold?: number;
  readonly offscreenPauseDelayMs?: number;
};

export function useCameraStream(
  cameraId: string,
  options: CameraStreamOptions = {},
): {
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly isLive: boolean;
  readonly hasError: boolean;
  readonly stats: MseStats | null;
  readonly refresh: () => void;
} {
  const { endpoint } = useOrion();
  const {
    enabled = true,
    pauseWhenOffscreen = true,
    pauseWhenHidden = true,
    intersectionThreshold = 0.01,
    offscreenPauseDelayMs = 3000,
  } = options;
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<MseSession | null>(null);
  const offscreenPausedRef = useRef(false);
  const visibilityPausedRef = useRef(false);
  const [isLive, setIsLive] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [stats, setStats] = useState<MseStats | null>(null);
  const [streamKey, setStreamKey] = useState(0);

  const applyPauseState = useCallback(() => {
    if (offscreenPausedRef.current || visibilityPausedRef.current) {
      sessionRef.current?.pause();
      setIsLive(false);
    } else {
      sessionRef.current?.resume();
    }
  }, []);

  useEffect(() => {
    void streamKey;
    const video = videoRef.current;
    sessionRef.current?.cleanup();
    sessionRef.current = null;
    setIsLive(false);
    setHasError(false);
    setStats(null);
    offscreenPausedRef.current = false;
    visibilityPausedRef.current =
      pauseWhenHidden && typeof document !== "undefined" && document.hidden;

    if (!enabled || !video || !cameraId || !endpoint) {
      return;
    }

    const wsUrl = buildCameraWsUrl(endpoint, cameraId);
    if (!wsUrl) {
      setHasError(true);
      return;
    }

    const session = connectMSE(video, wsUrl, {
      onLive: () => {
        setIsLive(true);
        setHasError(false);
      },
      onError: () => {
        setHasError(true);
        setIsLive(false);
      },
      onStats: setStats,
    });
    sessionRef.current = session;
    applyPauseState();

    return () => {
      session.cleanup();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [cameraId, endpoint, enabled, streamKey, pauseWhenHidden, applyPauseState]);

  useEffect(() => {
    if (!pauseWhenOffscreen || typeof IntersectionObserver === "undefined") return;
    const el = containerRef.current;
    if (!el) return;

    let pauseTimer: ReturnType<typeof setTimeout> | null = null;
    const io = new IntersectionObserver(
      (entries: IntersectionObserverEntry[]) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            if (pauseTimer) {
              clearTimeout(pauseTimer);
              pauseTimer = null;
            }
            offscreenPausedRef.current = false;
            applyPauseState();
          } else {
            if (pauseTimer) clearTimeout(pauseTimer);
            pauseTimer = setTimeout(() => {
              offscreenPausedRef.current = true;
              applyPauseState();
            }, offscreenPauseDelayMs);
          }
        }
      },
      { threshold: intersectionThreshold },
    );
    io.observe(el);

    return () => {
      if (pauseTimer) clearTimeout(pauseTimer);
      io.disconnect();
    };
  }, [pauseWhenOffscreen, intersectionThreshold, offscreenPauseDelayMs, applyPauseState]);

  useEffect(() => {
    if (!pauseWhenHidden || typeof document === "undefined") return;
    const handler = () => {
      visibilityPausedRef.current = document.hidden;
      applyPauseState();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [pauseWhenHidden, applyPauseState]);

  return {
    videoRef,
    containerRef,
    isLive,
    hasError,
    stats,
    refresh: () => setStreamKey((k) => k + 1),
  };
}
