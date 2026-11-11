import { useEffect, useRef, useState } from "react";
import { useTheme } from "../../app/providers";
import { type MessageKey, useT } from "../../i18n";
import { createOrionOrb, type OrbVariant, type OrionOrbController } from "./orion-orb";
import type { ActivityRowView, VoiceCallState } from "./types";

const ORB_STATE_KEYS: Record<VoiceCallState, MessageKey> = {
  idle: "voice.orb.idle",
  connecting: "voice.orb.connecting",
  listening: "voice.orb.listening",
  speaking: "voice.orb.speaking",
  working: "voice.orb.working",
  ended: "voice.orb.ended",
};

const SPOKEN_STATE_KEYS: Record<VoiceCallState, MessageKey> = {
  idle: "voice.state.idle",
  connecting: "voice.state.connecting",
  listening: "voice.state.listening",
  speaking: "voice.state.speaking",
  working: "voice.state.working",
  ended: "voice.state.ended",
};

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

export interface VoiceOrbProps {
  readonly state: VoiceCallState;
  readonly inputLevel: number;
  readonly outputLevel: number;
  readonly activities: readonly ActivityRowView[];
  readonly variant?: OrbVariant;
}

export function VoiceOrb({
  state,
  inputLevel,
  outputLevel,
  activities,
  variant = "stage",
}: VoiceOrbProps) {
  const t = useT();
  const { theme } = useTheme();
  const reducedMotion = usePrefersReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const controllerRef = useRef<OrionOrbController | null>(null);

  const stateLabel = t(ORB_STATE_KEYS[state]);
  const spokenState = t(SPOKEN_STATE_KEYS[state]);
  const wordmark = t("voice.orb.wordmark");
  const level = Math.max(inputLevel, outputLevel);
  const runningNames = activities
    .filter((a) => a.status === "running")
    .map((a) => a.text)
    .join(", ");
  const ariaLabel = runningNames ? `${spokenState}: ${runningNames}` : spokenState;

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ctrl = createOrionOrb(el, variant);
    controllerRef.current = ctrl;
    return () => {
      ctrl?.destroy();
      controllerRef.current = null;
    };
  }, [variant]);

  useEffect(() => {
    void theme;
    controllerRef.current?.refreshTheme();
  }, [theme]);

  useEffect(() => {
    controllerRef.current?.update({
      state,
      stateLabel,
      wordmark,
      level,
      activities,
      reducedMotion,
    });
  }, [state, stateLabel, wordmark, level, activities, reducedMotion]);

  return (
    <div className={`orbit-voice-orb-frame orbit-voice-orb-frame--${variant}`}>
      <canvas
        ref={canvasRef}
        className="orbit-voice-orb"
        role="img"
        aria-label={ariaLabel}
        data-testid="voice-orb"
        data-state={state}
      />
    </div>
  );
}
