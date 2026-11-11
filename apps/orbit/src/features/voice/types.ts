import type { Species } from "@orbit/schema";
import type { PlanErrorCode } from "../chat/PlanErrorCard";

export type VoiceCallState = "idle" | "connecting" | "listening" | "speaking" | "working" | "ended";

export type ActivityStatus = "running" | "done" | "error" | "stopped";

export interface VoiceCaption {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly final: boolean;
}

export interface ActivityRecord {
  readonly id: string;
  readonly name: string;
  readonly label?: string;
  readonly args?: unknown;
  readonly status: ActivityStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly result?: string;
  readonly details?: unknown;
  readonly handedOver: boolean;
}

export interface ActivityRowView {
  readonly id: string;
  readonly name: string;
  readonly status: ActivityStatus;
  readonly text: string;
  readonly chipLabel: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly canStop: boolean;
}

export type VoiceClientToolCallbacks = {
  readonly db_query: (parameters: unknown) => Promise<string>;
  readonly db_mutate: (parameters: unknown) => Promise<string>;
  readonly browser: (parameters: unknown) => Promise<string>;
  readonly orion_task: (parameters: unknown) => Promise<string>;
  readonly app: (parameters: unknown) => Promise<string>;
};

export interface VoiceSdkMessage {
  readonly role: "user" | "agent";
  readonly source?: "user" | "ai";
  readonly message: string;
  readonly event_id?: number;
  readonly response_id?: string;
}

export interface VoiceSdkResponsePart {
  readonly type: "start" | "delta" | "stop";
  readonly text?: string;
  readonly event_id?: number;
  readonly response_id?: string;
}

export interface VoiceSdkCorrection {
  readonly original_agent_response?: string;
  readonly corrected_agent_response?: string;
  readonly event_id?: number;
  readonly response_id?: string;
}

export interface VoiceSdkDisconnectDetails {
  readonly reason: "error" | "agent" | "user";
  readonly message?: string;
  readonly closeCode?: number;
  readonly closeReason?: string;
}

export interface VoiceSdkStartInput {
  readonly signedUrl: string;
  readonly refreshSignedUrl: () => Promise<{
    readonly voiceId: string;
    readonly signedUrl: string;
    readonly dynamicVariables: Record<string, string>;
  }>;
  readonly dynamicVariables: Record<string, string>;
  readonly clientTools: VoiceClientToolCallbacks;
  readonly onStatusChange: (
    status: "connecting" | "connected" | "disconnecting" | "disconnected",
  ) => void;
  readonly onModeChange: (mode: "listening" | "speaking") => void;
  readonly onMessage: (msg: VoiceSdkMessage) => void;
  readonly onAgentChatResponsePart: (part: VoiceSdkResponsePart) => void;
  readonly onAgentResponseCorrection: (corr: VoiceSdkCorrection) => void;
  readonly onTentativeUserTranscript: (text: string) => void;
  readonly onClientToolDispatched: (
    toolName: string,
    toolCallId: string,
    parameters: unknown,
  ) => void;
  readonly onError: (message: string, context?: unknown) => void;
  readonly onDisconnect: (details: VoiceSdkDisconnectDetails) => void;
}

export interface VoiceSessionHandle {
  readonly type: "voice" | "text";
  endSession(): Promise<void>;
  sendUserMessage(text: string): void;
  setMicMuted(muted: boolean): void;
  getInputVolume(): number;
  getOutputVolume(): number;
}

export interface VoiceSdkStartResult {
  readonly session: VoiceSessionHandle;
  readonly micUnavailable: boolean;
  readonly activeVoiceId?: string;
}

export type VoiceStartSessionFn = (input: VoiceSdkStartInput) => Promise<VoiceSdkStartResult>;

export interface StartVoiceOptions {
  readonly sessionId?: string | null;
  readonly resumeRecent?: boolean;
}

export interface VoiceContextValue {
  readonly state: VoiceCallState;
  readonly isLive: boolean;
  readonly sessionId: string | null;
  readonly voiceId: string | null;
  readonly muted: boolean;
  readonly micDenied: boolean;
  readonly inputLevel: number;
  readonly outputLevel: number;
  readonly captions: readonly VoiceCaption[];
  readonly tentativeUserText: string;
  readonly activities: readonly ActivityRowView[];
  readonly planError: { readonly code: PlanErrorCode; readonly message: string } | null;
  readonly error: string | null;
  readonly species: Species;
  start(options?: StartVoiceOptions): Promise<void>;
  stop(): Promise<void>;
  sendText(text: string): Promise<void>;
  setMuted(muted: boolean): void;
  abortTask(): Promise<void>;
  clearError(): void;
}
