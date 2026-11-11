import { Conversation } from "@elevenlabs/client";
import type {
  VoiceSdkDisconnectDetails,
  VoiceSdkStartInput,
  VoiceSdkStartResult,
  VoiceSessionHandle,
} from "./types";

export function buildVoiceSocketUrl(endpointUrl: string, path: string): string {
  const parsed = new URL(endpointUrl);
  const protocol =
    parsed.protocol === "https:" ? "wss:" : parsed.protocol === "http:" ? "ws:" : parsed.protocol;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${protocol}//${parsed.host}${normalizedPath}`;
}

export interface ElevenLabsWorkletAssets {
  readonly workletPaths: {
    readonly rawAudioProcessor: string;
    readonly audioConcatProcessor: string;
  };
  readonly libsampleratePath: string;
}

export function resolveWorkletAssets(
  baseUrl = import.meta.env?.BASE_URL ?? "/",
): ElevenLabsWorkletAssets {
  const prefix = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return {
    workletPaths: {
      rawAudioProcessor: `${prefix}vendor/elevenlabs/rawAudioProcessor.js`,
      audioConcatProcessor: `${prefix}vendor/elevenlabs/audioConcatProcessor.js`,
    },
    libsampleratePath: `${prefix}vendor/elevenlabs/libsamplerate.worklet.js`,
  };
}

const MIC_ERROR_NAMES = new Set([
  "NotAllowedError",
  "PermissionDeniedError",
  "NotFoundError",
  "DevicesNotFoundError",
  "NotReadableError",
  "TrackStartError",
  "OverconstrainedError",
  "ConstraintNotSatisfiedError",
  "AbortError",
  "SecurityError",
  "NotSupportedError",
]);

export function isMicrophoneError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const rec = err as { name?: unknown; message?: unknown };
    if (typeof rec.name === "string" && MIC_ERROR_NAMES.has(rec.name)) return true;
    if (typeof rec.message === "string") {
      const msg = rec.message.toLowerCase();
      return (
        msg.includes("microphone") ||
        msg.includes("permission") ||
        msg.includes("device not found") ||
        msg.includes("not supported") ||
        msg.includes("mediadevices") ||
        msg.includes("getusermedia") ||
        msg.includes("audiocontext") ||
        msg.includes("audioworklet") ||
        msg.includes("audio input")
      );
    }
  }
  return false;
}

function wrapConversation(conv: Conversation): VoiceSessionHandle {
  return {
    type: conv.type,
    endSession: () => conv.endSession(),
    sendUserMessage: (text: string) => conv.sendUserMessage(text),
    setMicMuted: (muted: boolean) => {
      if (conv.type === "voice") {
        conv.setMicMuted(muted);
      }
    },
    getInputVolume: () => conv.getInputVolume(),
    getOutputVolume: () => conv.getOutputVolume(),
  };
}

function asRecord(val: unknown): Record<string, unknown> | null {
  return val !== null && typeof val === "object" ? (val as Record<string, unknown>) : null;
}

export async function defaultStartVoiceSession(
  input: VoiceSdkStartInput,
): Promise<VoiceSdkStartResult> {
  const assets = resolveWorkletAssets();
  let activeAttempt = 0;
  let sessionReady = false;

  const makeCallbacks = (attemptId: number) => ({
    onConnect: () => undefined,
    onStatusChange: ({
      status,
    }: {
      status: "connecting" | "connected" | "disconnecting" | "disconnected";
    }) => {
      if (attemptId !== activeAttempt) return;
      if (status === "disconnected" && !sessionReady) return;
      input.onStatusChange(status);
    },
    onModeChange: ({ mode }: { mode: "listening" | "speaking" }) => {
      if (attemptId !== activeAttempt) return;
      input.onModeChange(mode);
    },
    onMessage: (msg: {
      role: "user" | "agent";
      source?: "user" | "ai";
      message: string;
      event_id?: number;
      response_id?: string;
    }) => {
      if (attemptId !== activeAttempt) return;
      input.onMessage(msg);
    },
    onAgentChatResponsePart: (part: {
      type: "start" | "delta" | "stop";
      text?: string;
      event_id?: number;
      response_id?: string;
    }) => {
      if (attemptId !== activeAttempt) return;
      input.onAgentChatResponsePart(part);
    },
    onAgentResponseCorrection: (corr: {
      original_agent_response?: string;
      corrected_agent_response?: string;
      event_id?: number;
      response_id?: string;
    }) => {
      if (attemptId !== activeAttempt) return;
      input.onAgentResponseCorrection(corr);
    },
    onIncomingEvent: (evt: unknown) => {
      if (attemptId !== activeAttempt) return;
      const obj = asRecord(evt);
      if (!obj) return;
      if (obj.type === "tentative_user_transcript") {
        const inner = asRecord(obj.tentative_user_transcription_event);
        if (typeof inner?.user_transcript === "string") {
          input.onTentativeUserTranscript(inner.user_transcript);
        }
        return;
      }
      if (obj.type === "client_tool_call") {
        const tc = asRecord(obj.client_tool_call);
        if (typeof tc?.tool_name === "string" && typeof tc?.tool_call_id === "string") {
          input.onClientToolDispatched(tc.tool_name, tc.tool_call_id, tc.parameters);
        }
      }
    },
    onError: (message: string, context?: unknown) => {
      if (attemptId !== activeAttempt) return;
      input.onError(message, context);
    },
    onDisconnect: (details: VoiceSdkDisconnectDetails) => {
      if (attemptId !== activeAttempt || !sessionReady) return;
      input.onDisconnect(details);
    },
  });

  const canAttemptMic =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window !== "undefined" &&
    ("AudioContext" in window || "webkitAudioContext" in window);

  if (canAttemptMic) {
    activeAttempt = 1;
    try {
      const conv = await Conversation.startSession({
        signedUrl: input.signedUrl,
        connectionType: "websocket",
        dynamicVariables: input.dynamicVariables,
        workletPaths: assets.workletPaths,
        libsampleratePath: assets.libsampleratePath,
        stripAudioTags: true,
        textOnly: false,
        clientTools: input.clientTools,
        ...makeCallbacks(1),
      });
      sessionReady = true;
      return { session: wrapConversation(conv), micUnavailable: false };
    } catch (err) {
      if (!isMicrophoneError(err)) {
        throw err;
      }
      const refreshed = await input.refreshSignedUrl();
      activeAttempt = 2;
      const textConv = await Conversation.startSession({
        signedUrl: refreshed.signedUrl,
        connectionType: "websocket",
        dynamicVariables: refreshed.dynamicVariables,
        stripAudioTags: true,
        textOnly: true,
        clientTools: input.clientTools,
        ...makeCallbacks(2),
      });
      sessionReady = true;
      return {
        session: wrapConversation(textConv),
        micUnavailable: true,
        activeVoiceId: refreshed.voiceId,
      };
    }
  }

  activeAttempt = 1;
  const textConv = await Conversation.startSession({
    signedUrl: input.signedUrl,
    connectionType: "websocket",
    dynamicVariables: input.dynamicVariables,
    stripAudioTags: true,
    textOnly: true,
    clientTools: input.clientTools,
    ...makeCallbacks(1),
  });
  sessionReady = true;
  return { session: wrapConversation(textConv), micUnavailable: true };
}
