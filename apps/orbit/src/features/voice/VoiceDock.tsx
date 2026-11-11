import { MessageSquare, Mic, MicOff, PhoneOff } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Link, useLocation } from "react-router";
import { Button } from "../../design";
import { useT } from "../../i18n";
import { isStageMounted, subscribeStageMounted } from "./stage-presence";
import { VoiceOrb } from "./VoiceOrb";
import { useVoice } from "./VoiceProvider";
import { VoiceStateBadge } from "./VoiceShared";

export function VoiceDock() {
  const t = useT();
  const voice = useVoice();
  const location = useLocation();
  const stageMounted = useSyncExternalStore(subscribeStageMounted, isStageMounted, isStageMounted);

  if (!voice.isLive) return null;
  if (location.pathname === "/" || stageMounted) return null;

  const chatHref = voice.sessionId ? `/chat?s=${encodeURIComponent(voice.sessionId)}` : "/chat";

  return (
    <aside
      className="orbit-voice-dock"
      aria-label={t("voice.dockAria")}
      data-testid="voice-dock"
      data-voice-state={voice.state}
    >
      <VoiceOrb
        variant="dock"
        state={voice.state}
        inputLevel={voice.inputLevel}
        outputLevel={voice.outputLevel}
        activities={voice.activities}
      />

      <div className="orbit-voice-dock__status">
        <strong className="orbit-voice-dock__title">{t("voice.title")}</strong>
        <VoiceStateBadge state={voice.state} />
      </div>

      <div className="orbit-voice-dock__actions">
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
          <span className="orbit-voice-dock__btn-label">
            {t(voice.muted ? "voice.action.muted" : "voice.action.mute")}
          </span>
        </Button>

        <Link
          to={chatHref}
          className="orbit-btn orbit-btn--secondary orbit-btn--sm"
          aria-label={t("voice.action.openChat")}
          title={t("voice.action.openChat")}
          data-testid="voice-dock-open-chat"
        >
          <MessageSquare size={15} aria-hidden="true" />
          <span className="orbit-voice-dock__btn-label">{t("voice.action.openChat")}</span>
        </Link>

        <Button
          type="button"
          variant="danger"
          size="sm"
          icon={<PhoneOff size={15} />}
          aria-label={t("voice.action.end")}
          onClick={() => void voice.stop()}
          data-testid="voice-end"
        >
          <span className="orbit-voice-dock__btn-label">{t("voice.action.end")}</span>
        </Button>
      </div>
    </aside>
  );
}
