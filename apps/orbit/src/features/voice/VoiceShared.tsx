import { AlertCircle, Loader2, MicOff, Send, X } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Badge, type BadgeVariant, Button } from "../../design";
import { type MessageKey, useT } from "../../i18n";
import { PlanErrorCard, type PlanErrorCode } from "../chat/PlanErrorCard";
import type { VoiceCallState, VoiceCaption } from "./types";

export function voiceStateMeta(state: VoiceCallState): {
  readonly variant: BadgeVariant;
  readonly key: MessageKey;
  readonly spinning: boolean;
} {
  switch (state) {
    case "idle":
      return { variant: "neutral", key: "voice.state.idle", spinning: false };
    case "connecting":
      return { variant: "warn", key: "voice.state.connecting", spinning: true };
    case "listening":
      return { variant: "ok", key: "voice.state.listening", spinning: false };
    case "speaking":
      return { variant: "info", key: "voice.state.speaking", spinning: false };
    case "working":
      return { variant: "accent", key: "voice.state.working", spinning: true };
    case "ended":
      return { variant: "neutral", key: "voice.state.ended", spinning: false };
  }
}

export function VoiceStateBadge({ state }: { readonly state: VoiceCallState }) {
  const t = useT();
  const meta = voiceStateMeta(state);
  return (
    <Badge
      variant={meta.variant}
      icon={meta.spinning ? <Loader2 size={12} className="orbit-spin" /> : undefined}
      data-testid="voice-state-badge"
    >
      {t(meta.key)}
    </Badge>
  );
}

export interface VoiceNoticesProps {
  readonly micDenied: boolean;
  readonly isLive: boolean;
  readonly planError: { readonly code: PlanErrorCode; readonly message: string } | null;
  readonly error: string | null;
  readonly onClearError: () => void;
  readonly showPlanError?: boolean;
}

export function VoiceNotices({
  micDenied,
  isLive,
  planError,
  error,
  onClearError,
  showPlanError = true,
}: VoiceNoticesProps) {
  const t = useT();
  return (
    <>
      {micDenied && isLive && (
        <div className="orbit-voice-notice" role="status" data-testid="voice-mic-error">
          <MicOff size={15} aria-hidden="true" />
          <div className="orbit-voice-notice__copy">
            <strong>{t("voice.micDenied.title")}</strong>
            <p>{t("voice.micDenied.body")}</p>
          </div>
        </div>
      )}
      {showPlanError && planError && (
        <PlanErrorCard
          code={planError.code}
          message={planError.message}
          surface="voice"
          onDismiss={onClearError}
        />
      )}
      {error && !planError && (
        <div className="orbit-voice-error" role="alert" data-testid="voice-error">
          <AlertCircle size={15} aria-hidden="true" />
          <span>{error}</span>
          <button
            type="button"
            className="orbit-thread__icon"
            aria-label={t("voice.action.dismiss")}
            onClick={onClearError}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  );
}

export interface VoiceCaptionsViewProps {
  readonly captions: readonly VoiceCaption[];
  readonly tentativeUserText: string;
}

export function VoiceCaptionsView({ captions, tentativeUserText }: VoiceCaptionsViewProps) {
  const t = useT();
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void captions.length;
    void tentativeUserText;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [captions, tentativeUserText]);

  const isEmpty = captions.length === 0 && !tentativeUserText;

  return (
    <div
      ref={scrollerRef}
      className="orbit-voice-captions"
      aria-live="polite"
      data-testid="voice-captions"
    >
      {isEmpty ? (
        <p className="orbit-voice-captions__empty">{t("voice.caption.empty")}</p>
      ) : (
        <>
          {captions.map((entry) => (
            <div
              key={entry.id}
              className="orbit-voice-caption"
              data-role={entry.role}
              data-final={entry.final ? "true" : "false"}
              data-testid={`voice-caption-${entry.role}`}
            >
              <span className="orbit-voice-caption__speaker">
                {entry.role === "user" ? t("voice.caption.you") : t("voice.caption.orion")}
              </span>
              <span className="orbit-voice-caption__text">{entry.text}</span>
            </div>
          ))}
          {tentativeUserText && (
            <div
              className="orbit-voice-caption"
              data-role="user"
              data-final="false"
              data-testid="voice-caption-tentative"
            >
              <span className="orbit-voice-caption__speaker">{t("voice.caption.you")}</span>
              <span className="orbit-voice-caption__text">{tentativeUserText}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export interface VoiceTextFormProps {
  readonly disabled: boolean;
  readonly onSend: (text: string) => Promise<void>;
}

export function VoiceTextForm({ disabled, onSend }: VoiceTextFormProps) {
  const t = useT();
  const [draft, setDraft] = useState("");

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || disabled) return;
    setDraft("");
    void onSend(trimmed);
  };

  return (
    <form className="orbit-voice-form" onSubmit={handleSubmit} data-testid="voice-text-form">
      <input
        type="text"
        className="orbit-input orbit-voice-form__input"
        placeholder={t("voice.input.placeholder")}
        aria-label={t("voice.input.aria")}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={disabled}
        autoComplete="off"
        data-testid="voice-text-input"
      />
      <Button
        type="submit"
        variant="secondary"
        size="sm"
        disabled={disabled || draft.trim().length === 0}
        icon={<Send size={14} />}
        data-testid="voice-text-send"
      >
        {t("voice.action.send")}
      </Button>
    </form>
  );
}
