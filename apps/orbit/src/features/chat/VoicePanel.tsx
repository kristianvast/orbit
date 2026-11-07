import {
  type EventFrame,
  OrionRequestError,
  type ServerEvent,
  type ToolItem,
} from "@orbit/protocol";
import { AlertCircle, Mic, MicOff, Send, Square, Volume2, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Badge, type BadgeVariant, Button } from "../../design";
import { type MessageKey, type TranslateFn, useT } from "../../i18n";
import { useOrion } from "../../lib/orion";
import { classifyPlanError, PlanErrorCard, type PlanErrorCode } from "./PlanErrorCard";
import { getFriendlyToolMeta, ToolCard } from "./ToolCard";
import { createAudioPlaybackQueue, startMicCapture } from "./voice-audio";

export type VoiceState = "connecting" | "listening" | "speaking" | "stopped";

export interface VoiceTranscriptEntry {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly final: boolean;
}

function stateBadgeMeta(state: VoiceState): { variant: BadgeVariant; key: MessageKey } {
  switch (state) {
    case "connecting":
      return { variant: "info", key: "chat.voice.state.connecting" };
    case "listening":
      return { variant: "ok", key: "chat.voice.state.listening" };
    case "speaking":
      return { variant: "accent", key: "chat.voice.state.speaking" };
    case "stopped":
      return { variant: "neutral", key: "chat.voice.state.stopped" };
  }
}

function parseVoiceDetails(raw?: string): unknown {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { result?: unknown };
    return parsed.result ?? parsed;
  } catch {
    return undefined;
  }
}

function mergeTranscript(
  prev: readonly VoiceTranscriptEntry[],
  ev: EventFrame<"voice.transcript">,
  nextId: string,
): VoiceTranscriptEntry[] {
  const last = prev[prev.length - 1];
  if (last && last.role === ev.role && !last.final) {
    return [...prev.slice(0, -1), { ...last, text: `${last.text}${ev.text}`, final: ev.final }];
  }
  return [...prev, { id: nextId, role: ev.role, text: ev.text, final: ev.final }];
}

function mergeVoiceTool(
  prev: readonly ToolItem[],
  ev: EventFrame<"voice.tool">,
  t: TranslateFn,
): ToolItem[] {
  const status: ToolItem["status"] =
    ev.state === "running" ? "running" : ev.isError ? "error" : "done";
  const existingIdx = prev.findIndex((item) => item.toolCallId === ev.toolCallId);
  const existing = existingIdx >= 0 ? prev[existingIdx] : undefined;
  const details = parseVoiceDetails(ev.result) ?? existing?.details;
  const result = ev.result !== undefined ? ev.result : existing?.result;
  const nextItem: ToolItem = {
    kind: "tool",
    id: ev.toolCallId,
    ts: existing?.ts ?? new Date().toISOString(),
    toolCallId: ev.toolCallId,
    name: ev.name,
    label: getFriendlyToolMeta(t, ev.name).title,
    args: ev.args !== undefined ? ev.args : existing?.args,
    status,
    ...(result !== undefined ? { result } : {}),
    ...(details !== undefined ? { details } : {}),
    ...(ev.isError !== undefined ? { isError: ev.isError } : {}),
  };
  if (existingIdx >= 0) {
    const copy = [...prev];
    copy[existingIdx] = nextItem;
    return copy;
  }
  return [...prev, nextItem];
}

export interface VoicePanelProps {
  readonly sessionId: string | null;
  readonly ensureSession: () => Promise<string>;
  readonly onClose: () => void;
}

export function VoicePanel({ sessionId, ensureSession, onClose }: VoicePanelProps) {
  const t = useT();
  const { client } = useOrion();

  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>("connecting");
  const [transcript, setTranscript] = useState<VoiceTranscriptEntry[]>([]);
  const [tools, setTools] = useState<ToolItem[]>([]);
  const [micDenied, setMicDenied] = useState(false);
  const [planError, setPlanError] = useState<{ code: PlanErrorCode; message: string } | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState("");

  const voiceIdRef = useRef<string | null>(null);
  const stoppedIdsRef = useRef<Set<string>>(new Set());
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;
  const ensureSessionRef = useRef(ensureSession);
  ensureSessionRef.current = ensureSession;

  const stopMicRef = useRef<(() => void) | null>(null);
  const playbackRef = useRef(createAudioPlaybackQueue());
  const seqRef = useRef(0);

  const cleanupAudio = useCallback(() => {
    stopMicRef.current?.();
    stopMicRef.current = null;
    playbackRef.current.stop();
  }, []);

  const recordError = useCallback((code: string | null | undefined, message: string) => {
    const pCode = classifyPlanError(code, message);
    if (pCode) setPlanError({ code: pCode, message });
    else setErrorText(message);
  }, []);

  useEffect(() => {
    if (!client) return;
    return client.on("*", (ev: ServerEvent) => {
      if ("voiceId" in ev) {
        if (stoppedIdsRef.current.has(ev.voiceId)) return;
        if (voiceIdRef.current && ev.voiceId !== voiceIdRef.current) return;
      }
      if (
        "sessionId" in ev &&
        ev.sessionId &&
        sessionIdRef.current &&
        ev.sessionId !== sessionIdRef.current
      ) {
        return;
      }
      switch (ev.type) {
        case "voice.state":
          voiceIdRef.current = ev.voiceId;
          setVoiceId(ev.voiceId);
          setVoiceState(ev.state);
          if (ev.state === "stopped") cleanupAudio();
          if (ev.error) recordError(null, ev.error);
          return;
        case "voice.audio":
          playbackRef.current.enqueue(ev.data, ev.sampleRate);
          return;
        case "voice.transcript":
          seqRef.current += 1;
          setTranscript((prev) => mergeTranscript(prev, ev, `vt-${seqRef.current}`));
          return;
        case "voice.tool":
          setTools((prev) => mergeVoiceTool(prev, ev, t));
          return;
        case "error":
          recordError(ev.code, ev.message);
          return;
        default:
          return;
      }
    });
  }, [client, cleanupAudio, recordError, t]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void (async () => {
      try {
        const resolvedSessionId = await ensureSessionRef.current();
        if (cancelled) return;
        sessionIdRef.current = resolvedSessionId;
        const started = await client.request("voice.start", { sessionId: resolvedSessionId });
        if (cancelled) {
          stoppedIdsRef.current.add(started.voiceId);
          void client.request("voice.stop", { voiceId: started.voiceId }).catch(() => {});
          return;
        }
        voiceIdRef.current = started.voiceId;
        setVoiceId(started.voiceId);

        const stopMic = await startMicCapture({
          onFrame: (data) => {
            const currentId = voiceIdRef.current;
            if (currentId && !cancelled) {
              void client.request("voice.audio", { voiceId: currentId, data }).catch(() => {});
            }
          },
          onPermissionDenied: () => {
            if (!cancelled) setMicDenied(true);
          },
          onCaptureError: (msg) => {
            if (!cancelled) {
              setMicDenied(true);
              setErrorText(msg);
            }
          },
        });
        if (cancelled) {
          stopMic();
          return;
        }
        stopMicRef.current = stopMic;
      } catch (err) {
        if (cancelled) return;
        cleanupAudio();
        setVoiceState("stopped");
        recordError(
          err instanceof OrionRequestError ? err.code : null,
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
    return () => {
      cancelled = true;
      cleanupAudio();
      const activeId = voiceIdRef.current;
      if (activeId) {
        stoppedIdsRef.current.add(activeId);
        voiceIdRef.current = null;
        void client.request("voice.stop", { voiceId: activeId }).catch(() => {});
      }
    };
  }, [client, cleanupAudio, recordError]);

  const handleStop = async () => {
    cleanupAudio();
    const activeId = voiceIdRef.current ?? voiceId;
    if (activeId) stoppedIdsRef.current.add(activeId);
    voiceIdRef.current = null;
    setVoiceState("stopped");
    if (client && activeId) {
      await client.request("voice.stop", { voiceId: activeId }).catch(() => {});
    }
  };

  const handleSendText = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = textDraft.trim();
    const activeId = voiceIdRef.current ?? voiceId;
    if (!client || !activeId || !trimmed) return;
    setTextDraft("");
    try {
      await client.request("voice.text", { voiceId: activeId, text: trimmed });
    } catch (err) {
      recordError(
        err instanceof OrionRequestError ? err.code : null,
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const badge = stateBadgeMeta(voiceState);

  return (
    <section
      className="orbit-voice-panel"
      aria-label={t("chat.voice.panelLabel")}
      data-testid="voice-panel"
      data-voice-state={voiceState}
    >
      <header className="orbit-voice-panel__header">
        <div className="orbit-voice-panel__status">
          <span className="orbit-voice-panel__indicator" data-state={voiceState} aria-hidden="true">
            {micDenied ? (
              <MicOff size={15} />
            ) : voiceState === "speaking" ? (
              <Volume2 size={15} />
            ) : (
              <Mic size={15} />
            )}
          </span>
          <strong className="orbit-voice-panel__title">{t("chat.voice.talkToOrion")}</strong>
          <Badge variant={badge.variant} data-testid="voice-state-badge">
            {t(badge.key)}
          </Badge>
        </div>
        <div className="orbit-voice-panel__actions">
          {voiceState !== "stopped" && (
            <Button
              type="button"
              variant="danger"
              size="sm"
              icon={<Square size={12} fill="currentColor" />}
              onClick={() => void handleStop()}
              data-testid="voice-stop-button"
            >
              {t("chat.voice.stop")}
            </Button>
          )}
          <button
            type="button"
            className="orbit-thread__icon"
            aria-label={t("chat.voice.close")}
            title={t("chat.voice.close")}
            onClick={() => void handleStop().then(onClose)}
            data-testid="voice-close-button"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      {micDenied && (
        <div className="orbit-voice-panel__notice" role="alert" data-testid="voice-mic-error">
          <MicOff size={15} aria-hidden="true" />
          <div>
            <strong>{t("chat.voice.micDeniedTitle")}</strong>
            <p>{t("chat.voice.micDeniedBody")}</p>
          </div>
        </div>
      )}

      {planError && (
        <PlanErrorCard
          code={planError.code}
          message={planError.message}
          onDismiss={() => setPlanError(null)}
        />
      )}

      {errorText && !planError && (
        <div className="orbit-chat-error" role="alert" data-testid="voice-error">
          <AlertCircle size={15} aria-hidden="true" />
          <span>{errorText}</span>
        </div>
      )}

      <div className="orbit-voice-panel__body" data-testid="voice-transcript">
        {transcript.length === 0 && tools.length === 0 && !planError ? (
          <p className="orbit-voice-panel__empty" data-testid="voice-empty">
            {t("chat.voice.emptyTranscript")}
          </p>
        ) : (
          <>
            {transcript.map((entry) => (
              <div
                key={entry.id}
                className="orbit-voice-entry"
                data-role={entry.role}
                data-final={entry.final ? "true" : "false"}
                data-testid={`voice-transcript-${entry.role}`}
              >
                <span className="orbit-voice-entry__speaker">
                  {entry.role === "user"
                    ? t("chat.voice.userLabel")
                    : t("chat.voice.assistantLabel")}
                </span>
                <span className="orbit-voice-entry__text">{entry.text}</span>
              </div>
            ))}
            {tools.length > 0 && (
              <div className="orbit-voice-panel__tools" data-testid="voice-tools">
                {tools.map((tool) => (
                  <ToolCard key={tool.toolCallId} item={tool} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {voiceState !== "stopped" && (
        <form
          className="orbit-voice-panel__form"
          onSubmit={(e) => void handleSendText(e)}
          data-testid="voice-text-form"
        >
          <input
            type="text"
            className="orbit-input orbit-voice-panel__input"
            placeholder={t("chat.voice.textPlaceholder")}
            aria-label={t("chat.voice.textPlaceholder")}
            value={textDraft}
            onChange={(e) => setTextDraft(e.target.value)}
            data-testid="voice-text-input"
          />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={!textDraft.trim() || !voiceId}
            icon={<Send size={14} />}
            data-testid="voice-text-send"
          >
            {t("chat.voice.textSend")}
          </Button>
        </form>
      )}
    </section>
  );
}
