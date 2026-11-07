export const MSE_CODECS = [
  "avc1.640029",
  "avc1.64002A",
  "avc1.640033",
  "hvc1.1.6.L153.B0",
  "mp4a.40.2",
  "mp4a.40.5",
  "flac",
  "opus",
] as const;

export type MseEventKind = "network" | "codec" | "stall" | "quota";
export type MseStats = {
  readonly droppedFrames: number;
  readonly totalFrames: number;
  readonly droppedFrameRate: number;
  readonly bufferedSeconds: number;
  readonly bandwidthKbps: number;
  readonly playbackRate: number;
  readonly latencySeconds: number;
};
export type MseEvents = {
  readonly onLive: () => void;
  readonly onError: (kind: MseEventKind, detail?: string) => void;
  readonly onStats?: (stats: MseStats) => void;
};
export type MseSession = {
  readonly cleanup: () => void;
  readonly pause: () => void;
  readonly resume: () => void;
};

type MediaSourceCtor = typeof MediaSource;

const isSafariOrIOS =
  typeof navigator !== "undefined" &&
  (/^((?!chrome|android).)*safari/i.test(navigator.userAgent) ||
    /iPhone|iPad|iPod/i.test(navigator.userAgent));

let activeConnectCount = 0;

export async function waitForConnectSlot(): Promise<void> {
  activeConnectCount += 1;
  try {
    if (activeConnectCount > 8 && typeof requestAnimationFrame === "function") {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  } finally {
    queueMicrotask(() => {
      activeConnectCount = Math.max(0, activeConnectCount - 1);
    });
  }
}

export function resolveMediaSource(): MediaSourceCtor | undefined {
  const g = globalThis as { MediaSource?: MediaSourceCtor; ManagedMediaSource?: MediaSourceCtor };
  return g.MediaSource ?? g.ManagedMediaSource;
}

export function computeBackoffMs(attempt: number): number {
  const raw = Math.min(15_000, 1000 * 2 ** attempt);
  return Math.max(250, Math.round(raw + raw * 0.25 * (Math.random() * 2 - 1)));
}

export function computeAdaptiveRate(bufferTime: number, avgBuffer: number): number {
  const threshold = avgBuffer * (isSafariOrIOS ? 3 : 1.5);
  if (bufferTime <= threshold || bufferTime <= 3) return 1;
  return Math.min(2, 1 + 0.2 * Math.exp(0.5 * (bufferTime - threshold)));
}

export function getSupportedCodecs(): string {
  const MS = resolveMediaSource();
  if (!MS) return "";
  return MSE_CODECS.filter((c) => MS.isTypeSupported(`video/mp4; codecs="${c}"`)).join();
}

export function startMseIntervals(params: {
  readonly video: HTMLVideoElement;
  readonly getBufferedSeconds: () => number;
  readonly consumeBytesLastSecond: () => number;
  readonly onStall: () => void;
  readonly onStats?: (stats: MseStats) => void;
}): () => void {
  let stallTicks = 0;
  const bufferSamples: number[] = [];

  const stallTimer = setInterval(() => {
    const buffered = params.getBufferedSeconds();
    stallTicks = buffered > 10 ? stallTicks + 1 : 0;
    if (stallTicks >= 2) {
      params.onStall();
      return;
    }
    bufferSamples.push(buffered);
    if (bufferSamples.length > 5) bufferSamples.shift();
    const avg = bufferSamples.reduce((a, b) => a + b, 0) / bufferSamples.length;
    params.video.playbackRate = computeAdaptiveRate(buffered, avg);
  }, 1000);

  const statsTimer = setInterval(() => {
    const q = params.video.getVideoPlaybackQuality();
    const latencySeconds = params.video.seekable.length
      ? Math.max(
          0,
          params.video.seekable.end(params.video.seekable.length - 1) - params.video.currentTime,
        )
      : 0;
    const bytes = params.consumeBytesLastSecond();
    params.onStats?.({
      droppedFrames: q.droppedVideoFrames,
      totalFrames: q.totalVideoFrames,
      droppedFrameRate: q.totalVideoFrames ? q.droppedVideoFrames / q.totalVideoFrames : 0,
      bufferedSeconds: params.getBufferedSeconds(),
      bandwidthKbps: bytes / 125,
      playbackRate: params.video.playbackRate,
      latencySeconds,
    });
  }, 1000);

  return () => {
    clearInterval(stallTimer);
    clearInterval(statsTimer);
  };
}
