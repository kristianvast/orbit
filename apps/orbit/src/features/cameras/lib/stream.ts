import {
  computeAdaptiveRate,
  computeBackoffMs,
  getSupportedCodecs,
  MSE_CODECS,
  type MseEventKind,
  type MseEvents,
  type MseSession,
  type MseStats,
  resolveMediaSource,
  startMseIntervals,
  waitForConnectSlot,
} from "./mse-helpers";

export { buildCameraSnapshotUrl, buildCameraWsUrl } from "./stream-urls";
export {
  computeAdaptiveRate,
  computeBackoffMs,
  getSupportedCodecs,
  MSE_CODECS,
  type MseEventKind,
  type MseEvents,
  type MseSession,
  type MseStats,
};

const MAX_CONSECUTIVE_FAILURES = 5;

export function connectMSE(video: HTMLVideoElement, wsUrl: string, events: MseEvents): MseSession {
  let ws: WebSocket | null = null;
  let ms: MediaSource | null = null;
  let sb: SourceBuffer | null = null;
  let objectUrl: string | null = null;
  let disposed = false;
  let paused = false;
  let intentionalClose = false;
  let connectGeneration = 0;
  let reconnectAttempt = 0;
  let consecutiveFailures = 0;
  let bytesReceivedInLastSecond = 0;
  let sourceOpenTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopIntervals: (() => void) | null = null;
  let updateEndHandler: (() => void) | null = null;
  const buf = new Uint8Array(2 * 1024 * 1024);
  let bufLen = 0;

  const getBufferedSeconds = () =>
    sb?.buffered.length
      ? Math.max(0, sb.buffered.end(sb.buffered.length - 1) - video.currentTime)
      : 0;

  const trimBuffer = (keepSeconds: number) => {
    if (!sb?.buffered.length || sb.updating) return false;
    const start = sb.buffered.start(0);
    const keep = Math.max(sb.buffered.end(sb.buffered.length - 1) - keepSeconds, start);
    if (keep <= start) return false;
    sb.remove(start, keep);
    return true;
  };

  const resetConnection = () => {
    if (sourceOpenTimer) clearTimeout(sourceOpenTimer);
    sourceOpenTimer = null;
    stopIntervals?.();
    stopIntervals = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      if (ws.readyState <= WebSocket.OPEN) ws.close();
      ws = null;
    }
    if (sb && updateEndHandler) sb.removeEventListener("updateend", updateEndHandler);
    updateEndHandler = null;
    sb = null;
    bufLen = 0;
    video.playbackRate = 1;
    if (ms?.readyState === "open") {
      try {
        ms.endOfStream();
      } catch (err) {
        if (!(err instanceof Error)) throw err;
      }
    }
    ms = null;
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    video.removeAttribute("src");
    video.load();
  };

  const scheduleReconnect = (kind: MseEventKind, detail?: string) => {
    if (disposed || paused) return;
    events.onError(kind, detail);
    resetConnection();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void startConnection();
    }, computeBackoffMs(reconnectAttempt++));
  };

  const stageChunk = (chunk: ArrayBuffer) => {
    const b = new Uint8Array(chunk);
    if (bufLen + b.byteLength > buf.byteLength) return false;
    buf.set(b, bufLen);
    bufLen += b.byteLength;
    return true;
  };

  const appendChunk = (chunk: ArrayBuffer) => {
    if (!sb || disposed || paused) return;
    if (sb.updating || bufLen > 0) {
      if (!stageChunk(chunk)) scheduleReconnect("quota", "staging buffer overflow");
      return;
    }
    try {
      sb.appendBuffer(chunk);
    } catch (err) {
      if (err instanceof DOMException && err.name === "QuotaExceededError") {
        if (!sb.updating && trimBuffer(2) && stageChunk(chunk)) return;
        scheduleReconnect("quota", err.message);
        return;
      }
      scheduleReconnect("codec", String(err));
    }
  };

  const maintainBuffer = () => {
    if (!sb || disposed || sb.updating) return;
    try {
      if (bufLen > 0) {
        sb.appendBuffer(buf.slice(0, bufLen));
        bufLen = 0;
        return;
      }
      if (sb.buffered.length) {
        const start = sb.buffered.end(sb.buffered.length - 1) - 5;
        const start0 = sb.buffered.start(0);
        if (start > start0) sb.remove(start0, start);
        if (video.currentTime < start) video.currentTime = start;
      }
    } catch (err) {
      if (!(err instanceof Error)) throw err;
    }
  };

  async function startConnection() {
    const generation = ++connectGeneration;
    await waitForConnectSlot();
    if (disposed || paused || generation !== connectGeneration) return;
    const MS = resolveMediaSource();
    if (!MS) {
      scheduleReconnect("codec", "MediaSource is not available");
      return;
    }
    intentionalClose = false;
    let networkErrorReported = false;
    const reportNetwork = (detail?: string) => {
      if (networkErrorReported) return;
      networkErrorReported = true;
      scheduleReconnect("network", detail);
    };
    ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      if (disposed || paused || !ws) return;
      ms = new MS();
      ms.addEventListener(
        "sourceopen",
        () => {
          if (disposed || paused || !ws || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: "mse", value: getSupportedCodecs() }));
          if (sourceOpenTimer) clearTimeout(sourceOpenTimer);
          sourceOpenTimer = setTimeout(() => {
            reconnectAttempt = 0;
          }, 10_000);
        },
        { once: true },
      );
      objectUrl = URL.createObjectURL(ms);
      video.src = objectUrl;
      video.play().catch(() => {
        video.muted = true;
        video.play().catch(() => undefined);
      });
    };
    ws.onmessage = (ev: MessageEvent<string | ArrayBuffer>) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data) as { type?: string; value?: string; error?: string };
          if (msg.type === "mse" && msg.value && ms?.readyState === "open") {
            sb = ms.addSourceBuffer(msg.value);
            sb.mode = "segments";
            updateEndHandler = maintainBuffer;
            sb.addEventListener("updateend", updateEndHandler);
            events.onLive();
            consecutiveFailures = 0;
            stopIntervals?.();
            stopIntervals = startMseIntervals({
              video,
              getBufferedSeconds,
              consumeBytesLastSecond: () => {
                const b = bytesReceivedInLastSecond;
                bytesReceivedInLastSecond = 0;
                return b;
              },
              onStall: () => scheduleReconnect("stall"),
              onStats: events.onStats,
            });
          } else if (msg.type === "error") {
            scheduleReconnect("codec", msg.error ?? msg.value);
          }
        } catch (err) {
          scheduleReconnect("codec", String(err));
        }
        return;
      }
      bytesReceivedInLastSecond += ev.data.byteLength;
      appendChunk(ev.data);
    };
    ws.onerror = () => reportNetwork("websocket error");
    ws.onclose = (ev) => {
      if (!intentionalClose && !disposed && !paused) {
        reportNetwork(ev.wasClean ? undefined : `websocket closed ${ev.code}`);
      }
    };
  }

  void startConnection();

  const stopActive = () => {
    intentionalClose = true;
    connectGeneration += 1;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    resetConnection();
  };

  return {
    pause: () => {
      if (!disposed && !paused) {
        paused = true;
        stopActive();
      }
    },
    resume: () => {
      if (!disposed && paused) {
        paused = false;
        reconnectAttempt = consecutiveFailures = 0;
        void startConnection();
      }
    },
    cleanup: () => {
      if (!disposed) {
        disposed = paused = true;
        stopActive();
      }
    },
  };
}
