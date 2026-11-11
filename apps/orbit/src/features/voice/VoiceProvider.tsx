import { OrionRequestError } from "@orbit/protocol";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useState,
} from "react";
import { useT } from "../../i18n";
import { useOrion } from "../../lib/orion";
import { useFarmSpecies } from "../../lib/species";
import { classifyPlanError, type PlanErrorCode } from "../chat/PlanErrorCard";
import { activityReducer, describeActivityRecord } from "./activity";
import { captionReducer, INITIAL_CAPTION_STATE } from "./captions";
import { defaultStartVoiceSession } from "./sdk";
import type {
  StartVoiceOptions,
  VoiceCallState,
  VoiceContextValue,
  VoiceStartSessionFn,
} from "./types";
import {
  type CallPhase,
  INITIAL_UI_STATE,
  useVoiceOrionLifecycle,
  useVoiceRuntimeBag,
  useVoiceVolumeMeter,
  type VoiceUiState,
} from "./voice-hooks";
import { runVoiceStartFlow } from "./voice-session-runner";

const VoiceContext = createContext<VoiceContextValue | null>(null);

export interface VoiceProviderProps {
  readonly children: ReactNode;
  readonly startSession?: VoiceStartSessionFn;
}

export function VoiceProvider({
  children,
  startSession = defaultStartVoiceSession,
}: VoiceProviderProps) {
  const { client, state: connState, endpoint } = useOrion();
  const { species } = useFarmSpecies();
  const t = useT();

  const [ui, setUi] = useState<VoiceUiState>(INITIAL_UI_STATE);
  const [captionState, captionDispatch] = useReducer(captionReducer, INITIAL_CAPTION_STATE);
  const [activityRecords, activityDispatch] = useReducer(activityReducer, []);

  const bagRef = useVoiceRuntimeBag({
    phase: ui.phase,
    sessionId: ui.sessionId,
    voiceId: ui.voiceId,
    client,
    endpoint,
    startSession,
  });

  const nextSeqId = useCallback((prefix: string) => `${prefix}-${++bagRef.current.seq}`, [bagRef]);

  const recordFailure = useCallback((code: string | null | undefined, message: string) => {
    const pCode = classifyPlanError(code, message);
    setUi((prev) =>
      pCode
        ? { ...prev, planError: { code: pCode, message }, error: null }
        : { ...prev, error: message },
    );
  }, []);

  const setLevels = useCallback((inputLevel: number, outputLevel: number) => {
    setUi((prev) =>
      Math.abs(prev.inputLevel - inputLevel) < 0.01 &&
      Math.abs(prev.outputLevel - outputLevel) < 0.01
        ? prev
        : { ...prev, inputLevel, outputLevel },
    );
  }, []);

  const teardownActiveCall = useCallback(
    async (nextPhase: CallPhase) => {
      const bag = bagRef.current;
      bag.callEpoch += 1;
      const handle = bag.sessionHandle;
      bag.sessionHandle = null;
      const activeVoiceId = bag.voiceId;
      bag.voiceId = null;
      bag.phase = nextPhase;
      setUi((prev) => ({
        ...prev,
        phase: nextPhase,
        voiceId: null,
        agentMode: "listening",
        muted: false,
        inputLevel: 0,
        outputLevel: 0,
      }));

      if (activeVoiceId) bag.stoppedVoiceIds.add(activeVoiceId);
      if (handle) await handle.endSession().catch(() => undefined);
      if (bag.client && activeVoiceId) {
        await bag.client.request("voice.stop", { voiceId: activeVoiceId }).catch(() => undefined);
      }
    },
    [bagRef],
  );

  const onPlanError = useCallback((code: PlanErrorCode, message: string) => {
    setUi((prev) => ({ ...prev, planError: { code, message }, error: null }));
  }, []);
  const onError = useCallback((message: string) => {
    setUi((prev) => ({ ...prev, error: message }));
  }, []);

  useVoiceOrionLifecycle({
    client,
    connState,
    bagRef,
    dispatchActivity: activityDispatch,
    onPlanError,
    onError,
    teardown: teardownActiveCall,
  });

  useVoiceVolumeMeter({ phase: ui.phase, bagRef, setLevels });

  const start = useCallback(
    async (options?: StartVoiceOptions) => {
      if (!bagRef.current.client) return;
      await teardownActiveCall("connecting");
      setUi((prev) => ({
        ...prev,
        planError: null,
        error: null,
        micDenied: false,
        muted: false,
        agentMode: "listening",
      }));
      bagRef.current.pendingToolIds.clear();
      captionDispatch({ type: "reset" });
      activityDispatch({ type: "reset" });

      await runVoiceStartFlow({
        options,
        bagRef,
        nextSeqId,
        setPhase: (phase) => setUi((prev) => ({ ...prev, phase })),
        setAgentMode: (agentMode) => setUi((prev) => ({ ...prev, agentMode })),
        setSessionId: (sessionId) => setUi((prev) => ({ ...prev, sessionId })),
        setVoiceId: (voiceId) => setUi((prev) => ({ ...prev, voiceId })),
        setMicDenied: (micDenied) => setUi((prev) => ({ ...prev, micDenied })),
        captionDispatch,
        activityDispatch,
        recordFailure,
        teardown: teardownActiveCall,
        fallbackErrorMsg: t("voice.error.connectionFailed"),
        streamInterruptedMsg: t("voice.error.streamInterrupted"),
      });
    },
    [bagRef, nextSeqId, recordFailure, t, teardownActiveCall],
  );

  const stop = useCallback(() => teardownActiveCall("ended"), [teardownActiveCall]);

  const sendText = useCallback(
    async (rawText: string) => {
      const clean = rawText.trim();
      const bag = bagRef.current;
      if (!clean || !bag.sessionHandle || !bag.voiceId) return;
      captionDispatch({
        type: "final.message",
        role: "user",
        text: clean,
        streamKey: null,
        nextId: nextSeqId("vcap"),
      });
      const turnPromise = bag.client
        ? bag.client
            .request("voice.turn", { voiceId: bag.voiceId, role: "user", text: clean })
            .catch((err: unknown) =>
              recordFailure(
                err instanceof OrionRequestError ? err.code : null,
                err instanceof Error ? err.message : String(err),
              ),
            )
        : Promise.resolve();
      bag.sessionHandle.sendUserMessage(clean);
      await turnPromise;
    },
    [bagRef, nextSeqId, recordFailure],
  );

  const setMuted = useCallback(
    (muted: boolean) => {
      bagRef.current.sessionHandle?.setMicMuted(muted);
      setUi((prev) => ({ ...prev, muted, ...(muted ? { inputLevel: 0 } : {}) }));
    },
    [bagRef],
  );

  const abortTask = useCallback(async () => {
    const bag = bagRef.current;
    if (!bag.sessionId || !bag.client) return;
    try {
      const res = await bag.client.request("chat.abort", { sessionId: bag.sessionId });
      if (!res.accepted) activityDispatch({ type: "task.stopped", now: Date.now() });
    } catch {
      activityDispatch({ type: "task.stopped", now: Date.now() });
    }
  }, [bagRef]);

  const clearError = useCallback(() => {
    setUi((prev) => ({ ...prev, planError: null, error: null }));
  }, []);

  const activities = useMemo(
    () => activityRecords.map((rec) => describeActivityRecord(rec, t, species)),
    [activityRecords, t, species],
  );
  const hasRunning = activityRecords.some((rec) => rec.status === "running");
  const state: VoiceCallState =
    ui.phase !== "active"
      ? ui.phase
      : ui.agentMode === "speaking"
        ? "speaking"
        : hasRunning
          ? "working"
          : "listening";

  const value: VoiceContextValue = {
    state,
    isLive: ui.phase === "connecting" || ui.phase === "active",
    sessionId: ui.sessionId,
    voiceId: ui.voiceId,
    muted: ui.muted,
    micDenied: ui.micDenied,
    inputLevel: ui.inputLevel,
    outputLevel: ui.outputLevel,
    captions: captionState.entries,
    tentativeUserText: captionState.tentativeUserText,
    activities,
    planError: ui.planError,
    error: ui.error,
    species,
    start,
    stop,
    sendText,
    setMuted,
    abortTask,
    clearError,
  };

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export function useVoice(): VoiceContextValue {
  const ctx = useContext(VoiceContext);
  if (!ctx) throw new Error("useVoice must be used within a <VoiceProvider>");
  return ctx;
}
