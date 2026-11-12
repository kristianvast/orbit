import { DEV_SERVER_URL, OrionRequestError } from "@orbit/protocol";
import type { MutableRefObject } from "react";
import { classifyPlanError } from "../chat/PlanErrorCard";
import type { ActivityAction } from "./activity";
import { type CaptionAction, streamKeyFor, stripSpeechTags } from "./captions";
import { createVoiceClientTools, openVoiceSessionOnOrion } from "./client-tools";
import { buildVoiceSocketUrl } from "./sdk";
import type { StartVoiceOptions } from "./types";
import { ORION_VOICE_IDS, readVoiceChoice } from "./voice-choice";
import type { CallPhase, VoiceRuntimeBag } from "./voice-hooks";

function isToolErrorContext(context: unknown): boolean {
  return (
    context !== null &&
    typeof context === "object" &&
    "clientToolName" in (context as Record<string, unknown>)
  );
}

export interface VoiceStartRunnerContext {
  readonly options: StartVoiceOptions | undefined;
  readonly bagRef: MutableRefObject<VoiceRuntimeBag>;
  readonly nextSeqId: (prefix: string) => string;
  readonly setPhase: (phase: CallPhase) => void;
  readonly setAgentMode: (mode: "listening" | "speaking") => void;
  readonly setSessionId: (id: string | null) => void;
  readonly setVoiceId: (id: string | null) => void;
  readonly setMicDenied: (denied: boolean) => void;
  readonly captionDispatch: (action: CaptionAction) => void;
  readonly activityDispatch: (action: ActivityAction) => void;
  readonly recordFailure: (code: string | null | undefined, message: string) => void;
  readonly teardown: (nextPhase: CallPhase) => Promise<void>;
  readonly fallbackErrorMsg: string;
  readonly streamInterruptedMsg: string;
}

export async function runVoiceStartFlow(ctx: VoiceStartRunnerContext): Promise<void> {
  const bag = ctx.bagRef.current;
  const activeClient = bag.client;
  if (!activeClient) return;

  const myEpoch = bag.callEpoch;
  let createdVoiceId: string | null = null;

  try {
    const opened = await openVoiceSessionOnOrion(activeClient, ctx.options);
    if (myEpoch !== bag.callEpoch) {
      bag.stoppedVoiceIds.add(opened.voiceId);
      void activeClient.request("voice.stop", { voiceId: opened.voiceId }).catch(() => undefined);
      return;
    }

    createdVoiceId = opened.voiceId;
    bag.voiceId = opened.voiceId;
    bag.sessionId = opened.sessionId;
    ctx.setSessionId(opened.sessionId);
    ctx.setVoiceId(opened.voiceId);

    const baseEndpointUrl = bag.endpoint?.url ?? DEV_SERVER_URL;
    const clientTools = createVoiceClientTools({
      getClient: () => bag.client,
      getVoiceId: () => bag.voiceId,
      claimToolCallId: (name) => bag.pendingToolIds.get(name)?.shift() ?? ctx.nextSeqId("vtool"),
      dispatchActivity: ctx.activityDispatch,
    });

    const sdkRes = await bag.startSession({
      signedUrl: buildVoiceSocketUrl(baseEndpointUrl, opened.path),
      dynamicVariables: opened.variables,
      voiceOverrideId: ORION_VOICE_IDS[readVoiceChoice()],
      refreshSignedUrl: async () => {
        const prevId = bag.voiceId;
        if (prevId) {
          bag.stoppedVoiceIds.add(prevId);
          await activeClient.request("voice.stop", { voiceId: prevId }).catch(() => undefined);
        }
        const refreshed = await activeClient.request("voice.start", {
          sessionId: opened.sessionId,
        });
        createdVoiceId = refreshed.voiceId;
        bag.voiceId = refreshed.voiceId;
        ctx.setVoiceId(refreshed.voiceId);
        return {
          voiceId: refreshed.voiceId,
          signedUrl: buildVoiceSocketUrl(baseEndpointUrl, refreshed.path),
          dynamicVariables: refreshed.variables,
        };
      },
      clientTools,
      onStatusChange: (status) => {
        if (myEpoch !== bag.callEpoch) return;
        if (status === "connected") {
          bag.phase = "active";
          ctx.setPhase("active");
        } else if (status === "disconnected") void ctx.teardown("ended");
      },
      onModeChange: (mode) => {
        if (myEpoch === bag.callEpoch) ctx.setAgentMode(mode);
      },
      onMessage: (msg) => {
        if (myEpoch !== bag.callEpoch) return;
        const role = msg.role === "user" || msg.source === "user" ? "user" : "assistant";
        const clean = role === "assistant" ? stripSpeechTags(msg.message) : msg.message.trim();
        if (!clean || (role === "user" && clean.startsWith("[Orion update] "))) return;
        ctx.captionDispatch({
          type: "final.message",
          role,
          text: clean,
          streamKey: role === "assistant" ? streamKeyFor(msg) : null,
          nextId: ctx.nextSeqId("vcap"),
        });
        if (bag.voiceId && bag.client) {
          void bag.client
            .request("voice.turn", { voiceId: bag.voiceId, role, text: clean })
            .catch((err: unknown) => {
              if (myEpoch !== bag.callEpoch) return;
              ctx.recordFailure(
                err instanceof OrionRequestError ? err.code : null,
                err instanceof Error ? err.message : ctx.fallbackErrorMsg,
              );
            });
        }
      },
      onAgentChatResponsePart: (part) => {
        if (myEpoch === bag.callEpoch) {
          ctx.captionDispatch({ type: "stream.part", part, nextId: ctx.nextSeqId("vcap") });
        }
      },
      onAgentResponseCorrection: (corr) => {
        if (myEpoch === bag.callEpoch) ctx.captionDispatch({ type: "stream.correction", corr });
      },
      onTentativeUserTranscript: (text) => {
        if (myEpoch === bag.callEpoch) ctx.captionDispatch({ type: "tentative.user", text });
      },
      onClientToolDispatched: (toolName, toolCallId) => {
        if (myEpoch !== bag.callEpoch) return;
        const list = bag.pendingToolIds.get(toolName) ?? [];
        list.push(toolCallId);
        bag.pendingToolIds.set(toolName, list);
      },
      onError: (message, context) => {
        if (myEpoch === bag.callEpoch && !isToolErrorContext(context)) {
          ctx.recordFailure(null, message || ctx.streamInterruptedMsg);
        }
      },
      onDisconnect: (details) => {
        if (myEpoch !== bag.callEpoch) return;
        if (details.closeCode === 4402) {
          ctx.recordFailure("budget_exceeded", details.closeReason ?? details.message ?? "");
        } else if (details.reason === "error" && details.message) {
          const pCode = classifyPlanError(null, details.message);
          if (pCode) ctx.recordFailure(pCode, details.message);
        }
        void ctx.teardown("ended");
      },
    });

    if (myEpoch !== bag.callEpoch) {
      await sdkRes.session.endSession().catch(() => undefined);
      const vIdToStop = sdkRes.activeVoiceId ?? createdVoiceId;
      if (vIdToStop) {
        bag.stoppedVoiceIds.add(vIdToStop);
        void activeClient.request("voice.stop", { voiceId: vIdToStop }).catch(() => undefined);
      }
      return;
    }

    if (sdkRes.activeVoiceId) {
      bag.voiceId = sdkRes.activeVoiceId;
      ctx.setVoiceId(sdkRes.activeVoiceId);
    }
    bag.sessionHandle = sdkRes.session;
    ctx.setMicDenied(sdkRes.micUnavailable);
    bag.phase = "active";
    ctx.setPhase("active");
  } catch (err) {
    if (myEpoch !== bag.callEpoch) return;
    const activeVId = bag.voiceId ?? createdVoiceId;
    bag.voiceId = null;
    ctx.setVoiceId(null);
    if (activeVId) {
      bag.stoppedVoiceIds.add(activeVId);
      void activeClient.request("voice.stop", { voiceId: activeVId }).catch(() => undefined);
    }
    bag.phase = "ended";
    ctx.setPhase("ended");
    ctx.recordFailure(
      err instanceof OrionRequestError ? err.code : null,
      err instanceof Error ? err.message : ctx.fallbackErrorMsg,
    );
  }
}
