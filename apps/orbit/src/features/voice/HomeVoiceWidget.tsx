import { MessageSquare, Mic, MicOff, PhoneOff } from "lucide-react";
import { Link } from "react-router";
import { Button } from "../../design";
import { useT } from "../../i18n";
import { ActivityList } from "./ActivityList";
import { VoiceOrb } from "./VoiceOrb";
import { useVoice } from "./VoiceProvider";
import { VoiceCaptionsView, VoiceNotices, VoiceStateBadge, VoiceTextForm } from "./VoiceShared";

export function HomeVoiceWidget() {
  const t = useT();
  const voice = useVoice();
  const chatHref = voice.sessionId ? `/chat?s=${encodeURIComponent(voice.sessionId)}` : "/chat";

  return (
    <section
      className="orbit-home-voice"
      aria-label={t("voice.widgetAria")}
      data-testid="home-orion-widget"
      data-voice-state={voice.state}
    >
      <div className="orbit-home-voice__top">
        <VoiceOrb
          variant="widget"
          state={voice.state}
          inputLevel={voice.inputLevel}
          outputLevel={voice.outputLevel}
          activities={voice.activities}
        />

        <div className="orbit-home-voice__summary">
          <div className="orbit-home-voice__header">
            <div className="orbit-home-voice__titles">
              <strong className="orbit-home-voice__title">{t("voice.title")}</strong>
              <VoiceStateBadge state={voice.state} />
            </div>

            <div className="orbit-home-voice__controls">
              {voice.isLive ? (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={voice.micDenied}
                    aria-pressed={voice.muted}
                    aria-label={t(
                      voice.muted ? "voice.action.unmuteAria" : "voice.action.muteAria",
                    )}
                    icon={voice.muted ? <MicOff size={15} /> : <Mic size={15} />}
                    onClick={() => voice.setMuted(!voice.muted)}
                    data-testid="voice-mute"
                  >
                    {t(voice.muted ? "voice.action.muted" : "voice.action.mute")}
                  </Button>
                  <Link
                    to={chatHref}
                    className="orbit-btn orbit-btn--secondary orbit-btn--sm"
                    data-testid="home-voice-open-chat"
                  >
                    <MessageSquare size={15} aria-hidden="true" />
                    <span>{t("voice.action.openChat")}</span>
                  </Link>
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
                </>
              ) : (
                <>
                  {voice.sessionId && voice.state === "ended" && (
                    <Link
                      to={chatHref}
                      className="orbit-btn orbit-btn--subtle orbit-btn--sm"
                      data-testid="home-voice-open-chat"
                    >
                      <MessageSquare size={15} aria-hidden="true" />
                      <span>{t("voice.action.openChat")}</span>
                    </Link>
                  )}
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    icon={<Mic size={15} />}
                    onClick={() => void voice.start({ resumeRecent: true })}
                    data-testid="home-voice-start"
                  >
                    {t(voice.state === "ended" ? "voice.action.startAgain" : "voice.action.start")}
                  </Button>
                </>
              )}
            </div>
          </div>

          {!voice.isLive && (
            <p className="orbit-home-voice__hint">
              {t(voice.species === "horse" ? "voice.idle.hint.horse" : "voice.idle.hint.cattle")}
            </p>
          )}

          <VoiceNotices
            micDenied={voice.micDenied}
            isLive={voice.isLive}
            planError={voice.planError}
            error={voice.error}
            onClearError={voice.clearError}
          />

          {voice.isLive && (
            <div className="orbit-home-voice__live">
              <ActivityList
                activities={voice.activities}
                onAbortTask={() => void voice.abortTask()}
              />
              <VoiceCaptionsView
                captions={voice.captions}
                tentativeUserText={voice.tentativeUserText}
              />
              <VoiceTextForm disabled={!voice.voiceId} onSend={(text) => voice.sendText(text)} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
