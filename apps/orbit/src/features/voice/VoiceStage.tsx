import { Mic, MicOff, PhoneOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../design";
import { useT } from "../../i18n";
import { useOrionEvent } from "../../lib/orion";
import { BrowserView } from "../guide";
import { ActivityList } from "./ActivityList";
import { markStageMounted } from "./stage-presence";
import type { VoiceCaption } from "./types";
import { VoiceOrb } from "./VoiceOrb";
import { useVoice } from "./VoiceProvider";
import { VoiceNotices, VoiceStateBadge } from "./VoiceShared";

export function selectStageLiveLine(
  captions: readonly VoiceCaption[],
  tentativeUserText: string,
): { readonly role: "user" | "assistant"; readonly text: string } | null {
  if (tentativeUserText.trim()) {
    return { role: "user", text: tentativeUserText.trim() };
  }
  for (let i = captions.length - 1; i >= 0; i -= 1) {
    const entry = captions[i];
    if (entry && !entry.final && entry.text.trim()) {
      return { role: entry.role, text: entry.text };
    }
  }
  return null;
}

export function VoiceStage() {
  const t = useT();
  const voice = useVoice();
  const [browserSessions, setBrowserSessions] = useState<Readonly<Record<string, boolean>>>({});

  useEffect(() => markStageMounted(), []);

  useOrionEvent("browser.view", (ev) => {
    setBrowserSessions((prev) => {
      const open = ev.image !== null && ev.image.length > 0;
      if (prev[ev.sessionId] === open) return prev;
      return { ...prev, [ev.sessionId]: open };
    });
  });

  const hasBrowserPage = Boolean(voice.sessionId && browserSessions[voice.sessionId]);
  const liveLine = selectStageLiveLine(voice.captions, voice.tentativeUserText);
  const hasFeedContent = liveLine !== null || voice.activities.length > 0;

  return (
    <section
      className="orbit-voice-stage"
      aria-label={t("voice.stageAria")}
      data-testid="voice-stage"
      data-voice-state={voice.state}
      data-browser-open={hasBrowserPage ? "true" : "false"}
    >
      <header className="orbit-voice-stage__header">
        <div className="orbit-voice-stage__titles">
          {hasBrowserPage && (
            <VoiceOrb
              variant="dock"
              state={voice.state}
              inputLevel={voice.inputLevel}
              outputLevel={voice.outputLevel}
              activities={voice.activities}
            />
          )}
          <strong className="orbit-voice-stage__title">{t("voice.title")}</strong>
          <VoiceStateBadge state={voice.state} />
        </div>
        <div className="orbit-voice-stage__controls">
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
        </div>
      </header>

      <div className="orbit-voice-stage__body">
        <VoiceNotices
          micDenied={voice.micDenied}
          isLive={voice.isLive}
          planError={voice.planError}
          error={voice.error}
          onClearError={voice.clearError}
          showPlanError={false}
        />

        {hasBrowserPage ? (
          <div className="orbit-voice-stage__browser-stack">
            {liveLine && (
              <div
                className="orbit-voice-live-line"
                data-role={liveLine.role}
                data-testid="voice-stage-live-caption"
              >
                <span className="orbit-voice-live-line__speaker">
                  {liveLine.role === "user" ? t("voice.caption.you") : t("voice.caption.orion")}
                </span>
                <span className="orbit-voice-live-line__text">{liveLine.text}</span>
              </div>
            )}
            <BrowserView sessionId={voice.sessionId} />
            <ActivityList
              activities={voice.activities}
              onAbortTask={() => void voice.abortTask()}
            />
          </div>
        ) : (
          <>
            <div
              className="orbit-voice-stage__compact"
              data-has-feed={hasFeedContent ? "true" : "false"}
            >
              <VoiceOrb
                variant="stage"
                state={voice.state}
                inputLevel={voice.inputLevel}
                outputLevel={voice.outputLevel}
                activities={voice.activities}
              />
              {hasFeedContent && (
                <div className="orbit-voice-stage__feed">
                  {liveLine && (
                    <div
                      className="orbit-voice-live-line"
                      data-role={liveLine.role}
                      data-testid="voice-stage-live-caption"
                    >
                      <span className="orbit-voice-live-line__speaker">
                        {liveLine.role === "user"
                          ? t("voice.caption.you")
                          : t("voice.caption.orion")}
                      </span>
                      <span className="orbit-voice-live-line__text">{liveLine.text}</span>
                    </div>
                  )}
                  <ActivityList
                    activities={voice.activities}
                    onAbortTask={() => void voice.abortTask()}
                  />
                </div>
              )}
            </div>
            <BrowserView sessionId={voice.sessionId} />
          </>
        )}
      </div>
    </section>
  );
}
