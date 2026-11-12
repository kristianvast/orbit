import { useCallback, useState } from "react";

/** Orion's speaking voice. The ids are the website demo's voices on ElevenLabs. */
export type OrionVoiceChoice = "male" | "female";

export const ORION_VOICE_IDS: Record<OrionVoiceChoice, string> = {
  male: "iP95p4xoKVk53GoZ742B",
  female: "EXAVITQu4vr4xnSDxMaL",
};

const STORAGE_KEY = "orbit.voice";

export function readVoiceChoice(): OrionVoiceChoice {
  try {
    return window.localStorage?.getItem(STORAGE_KEY) === "female" ? "female" : "male";
  } catch {
    return "male";
  }
}

export function useVoiceChoice(): readonly [OrionVoiceChoice, (next: OrionVoiceChoice) => void] {
  const [choice, setChoice] = useState<OrionVoiceChoice>(readVoiceChoice);
  const update = useCallback((next: OrionVoiceChoice) => {
    setChoice(next);
    try {
      window.localStorage?.setItem(STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode); the choice then lasts for this window only.
    }
  }, []);
  return [choice, update] as const;
}
