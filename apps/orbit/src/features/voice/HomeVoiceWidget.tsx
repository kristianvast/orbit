import { ArrowUp, MessageSquare, Mic, MicOff, PhoneOff, Send } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { Link } from "react-router";
import { Button } from "../../design";
import { useT } from "../../i18n";
import { ActivityList } from "./ActivityList";
import { VoiceOrb } from "./VoiceOrb";
import { useVoice } from "./VoiceProvider";
import { VoiceCaptionsView, VoiceNotices, VoiceStateBadge } from "./VoiceShared";

export interface HomeAskField {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly placeholder: string;
}

export interface HomeVoiceWidgetProps {
  /** Home's ask box; without it (Orion cannot answer yet) only the call button shows. */
  readonly ask?: HomeAskField;
  /** Starter questions, shown under the box while no call is live. */
  readonly children?: ReactNode;
}

export function HomeVoiceWidget({ ask, children }: HomeVoiceWidgetProps) {
  const t = useT();
  const voice = useVoice();
  const [draft, setDraft] = useState("");
  const chatHref = voice.sessionId ? `/chat?s=${encodeURIComponent(voice.sessionId)}` : "/chat";

  const sendIntoCall = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !voice.voiceId) return;
    setDraft("");
    void voice.sendText(text);
  };

  return (
    <section
      className="orbit-home-voice"
      aria-label={t("voice.widgetAria")}
      data-testid="home-orion-widget"
      data-voice-state={voice.state}
    >
      <VoiceOrb
        variant="widget"
        state={voice.state}
        inputLevel={voice.inputLevel}
        outputLevel={voice.outputLevel}
        activities={voice.activities}
      />

      <div className="orbit-home-voice__header">
        <div className="orbit-home-voice__titles">
          <strong className="orbit-home-voice__title">{t("voice.title")}</strong>
          <VoiceStateBadge state={voice.state} />
        </div>
        {voice.sessionId && (voice.isLive || voice.state === "ended") && (
          <Link
            to={chatHref}
            className="orbit-btn orbit-btn--subtle orbit-btn--sm"
            data-testid="home-voice-open-chat"
          >
            <MessageSquare size={15} aria-hidden="true" />
            <span>{t("voice.action.openChat")}</span>
          </Link>
        )}
      </div>

      <VoiceNotices
        micDenied={voice.micDenied}
        isLive={voice.isLive}
        planError={voice.planError}
        error={voice.error}
        onClearError={voice.clearError}
      />

      {voice.isLive && (
        <div className="orbit-home-voice__live">
          <ActivityList activities={voice.activities} onAbortTask={() => void voice.abortTask()} />
          <VoiceCaptionsView
            captions={voice.captions}
            tentativeUserText={voice.tentativeUserText}
          />
        </div>
      )}

      {voice.isLive ? (
        <form className="orbit-ask" onSubmit={sendIntoCall} data-testid="voice-text-form">
          <input
            className="orbit-ask__input"
            placeholder={t("voice.input.placeholder")}
            aria-label={t("voice.input.aria")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!voice.voiceId}
            autoComplete="off"
            data-testid="voice-text-input"
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={voice.micDenied}
            aria-pressed={voice.muted}
            aria-label={t(voice.muted ? "voice.action.unmuteAria" : "voice.action.muteAria")}
            icon={voice.muted ? <MicOff size={15} /> : <Mic size={15} />}
            onClick={() => voice.setMuted(!voice.muted)}
            data-testid="voice-mute"
          >
            {t(voice.muted ? "voice.action.muted" : "voice.action.mute")}
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            icon={<PhoneOff size={15} />}
            onClick={() => void voice.stop()}
            data-testid="voice-end"
          >
            {t("voice.action.end")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!voice.voiceId || draft.trim().length === 0}
            icon={<Send size={14} />}
            data-testid="voice-text-send"
          >
            {t("voice.action.send")}
          </Button>
        </form>
      ) : (
        <form
          className="orbit-ask"
          onSubmit={ask ? ask.onSubmit : (e) => e.preventDefault()}
          data-testid="home-ask-form"
        >
          {ask && (
            <>
              <label htmlFor="home-ask-orion" className="orbit-visually-hidden">
                {t("home.ask.label")}
              </label>
              <input
                id="home-ask-orion"
                data-testid="home-ask-input"
                className="orbit-ask__input"
                value={ask.value}
                onChange={(e) => ask.onChange(e.target.value)}
                placeholder={ask.placeholder}
                autoComplete="off"
              />
            </>
          )}
          <Button
            type="button"
            variant={ask ? "secondary" : "primary"}
            size="sm"
            icon={<Mic size={15} />}
            onClick={() => void voice.start({ resumeRecent: true })}
            data-testid="home-voice-start"
          >
            {t(voice.state === "ended" ? "voice.action.startAgain" : "voice.action.start")}
          </Button>
          {ask && (
            <Button
              type="submit"
              variant="primary"
              size="sm"
              icon={<ArrowUp size={16} />}
              data-testid="home-ask-submit"
            >
              {t("home.ask.submit")}
            </Button>
          )}
        </form>
      )}

      {!voice.isLive && children}
    </section>
  );
}
