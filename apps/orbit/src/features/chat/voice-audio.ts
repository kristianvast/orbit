// AudioWorklet capture -> resample to 16 kHz PCM16 -> base64, and 24 kHz PCM16 AudioContext playback queue.

export const TARGET_INPUT_SAMPLE_RATE = 16_000;
export const DEFAULT_OUTPUT_SAMPLE_RATE = 24_000;
const WORKLET_PROCESSOR_NAME = "orbit-voice-capture-processor";

const WORKLET_SOURCE = `
class OrbitVoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(2048);
    this._offset = 0;
  }
  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (!channel || channel.length === 0) return true;
    for (let i = 0; i < channel.length; i++) {
      this._buffer[this._offset++] = channel[i];
      if (this._offset >= this._buffer.length) {
        this.port.postMessage(this._buffer.slice(0));
        this._offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("${WORKLET_PROCESSOR_NAME}", OrbitVoiceCaptureProcessor);
`;

function floatToPcm16Sample(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

/** Resamples mono Float32 audio from inputSampleRate to 16 kHz signed 16-bit PCM. */
export function resampleTo16kHzPcm16(samples: Float32Array, inputSampleRate: number): Int16Array {
  if (samples.length === 0) return new Int16Array(0);
  if (inputSampleRate <= 0 || inputSampleRate === TARGET_INPUT_SAMPLE_RATE) {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      out[i] = floatToPcm16Sample(samples[i] ?? 0);
    }
    return out;
  }

  const ratio = inputSampleRate / TARGET_INPUT_SAMPLE_RATE;
  const outLength = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s0 = samples[idx] ?? 0;
    const s1 = samples[Math.min(samples.length - 1, idx + 1)] ?? s0;
    const interpolated = s0 + (s1 - s0) * frac;
    out[i] = floatToPcm16Sample(interpolated);
  }
  return out;
}

/** Encodes little-endian Int16Array to base64 (capped within protocol 64 KiB frame limit). */
export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(bytes.length, i + chunkSize));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/** Decodes base64 little-endian PCM16 mono into normalized Float32Array samples [-1, 1]. */
export function base64ToPcm16Float32(base64: string): Float32Array {
  const binary = atob(base64);
  const byteLength = binary.length - (binary.length % 2);
  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  const sampleCount = byteLength / 2;
  const floats = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const int16 = view.getInt16(i * 2, true);
    floats[i] = int16 / 0x8000;
  }
  return floats;
}

export interface AudioPlaybackQueue {
  enqueue(base64Data: string, sampleRate?: number): void;
  stop(): void;
}

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function createAudioPlaybackQueue(): AudioPlaybackQueue {
  let ctx: AudioContext | null = null;
  let nextStartTime = 0;
  const activeSources = new Set<AudioBufferSourceNode>();

  const ensureContext = (sampleRate: number): AudioContext | null => {
    if (ctx && ctx.state !== "closed") return ctx;
    const Ctor = getAudioContextConstructor();
    if (!Ctor) return null;
    try {
      ctx = new Ctor({ sampleRate });
      nextStartTime = 0;
      return ctx;
    } catch {
      return null;
    }
  };

  return {
    enqueue(base64Data: string, sampleRate = DEFAULT_OUTPUT_SAMPLE_RATE) {
      let samples: Float32Array;
      try {
        samples = base64ToPcm16Float32(base64Data);
      } catch {
        return;
      }
      if (samples.length === 0) return;

      const audioCtx = ensureContext(sampleRate);
      if (!audioCtx) return;

      if (audioCtx.state === "suspended") {
        void audioCtx.resume().catch(() => undefined);
      }

      try {
        const buffer = audioCtx.createBuffer(1, samples.length, sampleRate);
        buffer.getChannelData(0).set(samples);
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);
        const startAt = Math.max(audioCtx.currentTime, nextStartTime);
        source.start(startAt);
        nextStartTime = startAt + buffer.duration;
        activeSources.add(source);
        source.onended = () => {
          activeSources.delete(source);
        };
      } catch {
        // Ignore playback errors on unsupported headless environments
      }
    },
    stop() {
      for (const s of activeSources) {
        try {
          s.stop();
          s.disconnect();
        } catch {
          // Ignore already-stopped source
        }
      }
      activeSources.clear();
      nextStartTime = 0;
      if (ctx && ctx.state !== "closed") {
        void ctx.close().catch(() => undefined);
      }
      ctx = null;
    },
  };
}

export interface MicCaptureOptions {
  readonly onFrame: (base64Pcm16: string) => void;
  readonly onPermissionDenied: () => void;
  readonly onCaptureError?: (message: string) => void;
}

export async function startMicCapture(options: MicCaptureOptions): Promise<() => void> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return () => {};
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: TARGET_INPUT_SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  } catch {
    options.onPermissionDenied();
    return () => {};
  }

  const stopStream = () => {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  };

  const Ctor = getAudioContextConstructor();
  if (!Ctor) {
    stopStream();
    options.onCaptureError?.("AudioContext is not available in this browser.");
    return () => {};
  }

  let ctx: AudioContext | null = null;
  let blobUrl: string | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;

  try {
    ctx = new Ctor({ sampleRate: TARGET_INPUT_SAMPLE_RATE });
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    if (!ctx.audioWorklet || typeof URL.createObjectURL !== "function") {
      throw new Error("AudioWorklet is not supported in this browser.");
    }
    sourceNode = ctx.createMediaStreamSource(stream);
    const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
    blobUrl = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(blobUrl);
    workletNode = new AudioWorkletNode(ctx, WORKLET_PROCESSOR_NAME);
    const actualSampleRate = ctx.sampleRate || TARGET_INPUT_SAMPLE_RATE;
    workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!(event.data instanceof Float32Array)) return;
      const pcm16 = resampleTo16kHzPcm16(event.data, actualSampleRate);
      if (pcm16.length > 0) {
        options.onFrame(pcm16ToBase64(pcm16));
      }
    };
    sourceNode.connect(workletNode);
    workletNode.connect(ctx.destination);
  } catch (err) {
    try {
      workletNode?.disconnect();
      sourceNode?.disconnect();
    } catch {
      // Ignore disconnect errors during cleanup
    }
    if (blobUrl && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(blobUrl);
    }
    if (ctx && ctx.state !== "closed") {
      void ctx.close().catch(() => undefined);
    }
    stopStream();
    const msg = err instanceof Error ? err.message : String(err);
    if (options.onCaptureError) {
      options.onCaptureError(msg);
    } else {
      options.onPermissionDenied();
    }
    return () => {};
  }

  return () => {
    try {
      workletNode?.disconnect();
      sourceNode?.disconnect();
    } catch {
      // Ignore disconnect errors
    }
    if (blobUrl && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(blobUrl);
    }
    if (ctx && ctx.state !== "closed") {
      void ctx.close().catch(() => undefined);
    }
    stopStream();
  };
}
