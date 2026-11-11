import type { ConnectionState, OrionClient, ServerEvent } from "@orbit/protocol";
import { type MutableRefObject, useEffect, useRef } from "react";
import type { OrionEndpoint } from "../../lib/orion";
import { classifyPlanError, type PlanErrorCode } from "../chat/PlanErrorCard";
import type { ActivityAction } from "./activity";
import type { VoiceSessionHandle, VoiceStartSessionFn } from "./types";

export type CallPhase = "idle" | "connecting" | "active" | "ended";

export interface VoiceUiState {
  readonly phase: CallPhase;
  readonly agentMode: "listening" | "speaking";
  readonly sessionId: string | null;
  readonly voiceId: string | null;
  readonly muted: boolean;
  readonly micDenied: boolean;
  readonly inputLevel: number;
  readonly outputLevel: number;
  readonly planError: { readonly code: PlanErrorCode; readonly message: string } | null;
  readonly error: string | null;
}

export const INITIAL_UI_STATE: VoiceUiState = {
  phase: "idle",
  agentMode: "listening",
  sessionId: null,
  voiceId: null,
  muted: false,
  micDenied: false,
  inputLevel: 0,
  outputLevel: 0,
  planError: null,
  error: null,
};

export interface VoiceRuntimeBag {
  phase: CallPhase;
  sessionId: string | null;
  voiceId: string | null;
  client: OrionClient | null;
  endpoint: OrionEndpoint | null;
  startSession: VoiceStartSessionFn;
  sessionHandle: VoiceSessionHandle | null;
  readonly stoppedVoiceIds: Set<string>;
  readonly pendingToolIds: Map<string, string[]>;
  seq: number;
  callEpoch: number;
}

export function useVoiceRuntimeBag(init: {
  readonly phase: CallPhase;
  readonly sessionId: string | null;
  readonly voiceId: string | null;
  readonly client: OrionClient | null;
  readonly endpoint: OrionEndpoint | null;
  readonly startSession: VoiceStartSessionFn;
}): MutableRefObject<VoiceRuntimeBag> {
  const bagRef = useRef<VoiceRuntimeBag>({
    phase: init.phase,
    sessionId: init.sessionId,
    voiceId: init.voiceId,
    client: init.client,
    endpoint: init.endpoint,
    startSession: init.startSession,
    sessionHandle: null,
    stoppedVoiceIds: new Set(),
    pendingToolIds: new Map(),
    seq: 0,
    callEpoch: 0,
  });
  bagRef.current.phase = init.phase;
  bagRef.current.sessionId = init.sessionId;
  bagRef.current.voiceId = init.voiceId;
  bagRef.current.client = init.client;
  bagRef.current.endpoint = init.endpoint;
  bagRef.current.startSession = init.startSession;
  return bagRef;
}

export interface VoiceOrionEventsBinding {
  readonly client: OrionClient | null;
  readonly connState: ConnectionState;
  readonly bagRef: MutableRefObject<VoiceRuntimeBag>;
  readonly dispatchActivity: (action: ActivityAction) => void;
  readonly onPlanError: (code: PlanErrorCode, message: string) => void;
  readonly onError: (message: string) => void;
  readonly teardown: (nextPhase: CallPhase) => Promise<void>;
}

export function useVoiceOrionLifecycle(b: VoiceOrionEventsBinding): void {
  const { client, connState, bagRef, dispatchActivity, onPlanError, onError, teardown } = b;

  useEffect(() => {
    if (!client) return;
    return client.on("*", (ev: ServerEvent) => {
      const bag = bagRef.current;
      if (ev.type === "voice.note") {
        if (!bag.voiceId || ev.voiceId !== bag.voiceId) return;
        dispatchActivity({ type: "voice.note", now: Date.now(), text: ev.text });
        bag.sessionHandle?.sendUserMessage(`[Orion update] ${ev.text}`);
        return;
      }
      if (ev.type === "error") {
        if (ev.sessionId && bag.sessionId && ev.sessionId !== bag.sessionId) return;
        const pCode = classifyPlanError(ev.code, ev.message);
        if (pCode) onPlanError(pCode, ev.message);
        else if (bag.phase === "connecting" || bag.phase === "active") onError(ev.message);
        return;
      }
      if (!bag.sessionId || !("sessionId" in ev) || ev.sessionId !== bag.sessionId) return;
      if (bag.phase === "idle") return;
      if (ev.type === "tool.start") dispatchActivity({ type: "tool.start", ev, now: Date.now() });
      else if (ev.type === "tool.update") dispatchActivity({ type: "tool.update", ev });
      else if (ev.type === "tool.end") dispatchActivity({ type: "tool.end", ev, now: Date.now() });
      else if (ev.type === "agent.settled") {
        dispatchActivity({ type: "agent.settled", ev, now: Date.now() });
      }
    });
  }, [bagRef, client, dispatchActivity, onError, onPlanError]);

  useEffect(() => {
    const phase = bagRef.current.phase;
    if (connState !== "open" && (phase === "connecting" || phase === "active")) {
      void teardown("ended");
    }
  }, [bagRef, connState, teardown]);

  useEffect(
    () => () => {
      const bag = bagRef.current;
      const handle = bag.sessionHandle;
      bag.sessionHandle = null;
      const activeVoiceId = bag.voiceId;
      bag.voiceId = null;
      if (handle) void handle.endSession().catch(() => undefined);
      if (bag.client && activeVoiceId && !bag.stoppedVoiceIds.has(activeVoiceId)) {
        bag.stoppedVoiceIds.add(activeVoiceId);
        void bag.client.request("voice.stop", { voiceId: activeVoiceId }).catch(() => undefined);
      }
    },
    [bagRef],
  );
}

export function useVoiceVolumeMeter(input: {
  readonly phase: CallPhase;
  readonly bagRef: MutableRefObject<VoiceRuntimeBag>;
  readonly setLevels: (inLevel: number, outLevel: number) => void;
}): void {
  const { phase, bagRef, setLevels } = input;
  useEffect(() => {
    if (phase !== "active" || typeof window === "undefined") return;
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    let rafId = 0;
    const sample = () => {
      const handle = bagRef.current.sessionHandle;
      if (handle?.type === "voice") {
        const inVol = Math.max(0, Math.min(1, handle.getInputVolume() || 0));
        const outVol = Math.max(0, Math.min(1, handle.getOutputVolume() || 0));
        setLevels(inVol, outVol);
      }
      rafId = window.requestAnimationFrame(sample);
    };
    rafId = window.requestAnimationFrame(sample);
    return () => window.cancelAnimationFrame(rafId);
  }, [bagRef, phase, setLevels]);
}
