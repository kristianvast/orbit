import type { VoiceCaption, VoiceSdkCorrection, VoiceSdkResponsePart } from "./types";

export function stripSpeechTags(raw: string): string {
  return raw
    .replace(/\[[a-zA-Z][a-zA-Z\s_-]{0,24}\]\s*/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export interface CaptionStoreState {
  readonly entries: readonly VoiceCaption[];
  readonly tentativeUserText: string;
  readonly streamMap: Readonly<
    Record<string, { readonly captionId: string; readonly raw: string }>
  >;
}

export const INITIAL_CAPTION_STATE: CaptionStoreState = {
  entries: [],
  tentativeUserText: "",
  streamMap: {},
};

export type CaptionAction =
  | { readonly type: "reset" }
  | { readonly type: "tentative.user"; readonly text: string }
  | { readonly type: "stream.part"; readonly part: VoiceSdkResponsePart; readonly nextId: string }
  | { readonly type: "stream.correction"; readonly corr: VoiceSdkCorrection }
  | {
      readonly type: "final.message";
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly streamKey: string | null;
      readonly nextId: string;
    };

export function streamKeyFor(meta: {
  readonly response_id?: string;
  readonly event_id?: number;
}): string | null {
  if (meta.response_id) return `resp:${meta.response_id}`;
  if (meta.event_id !== undefined) return `ev:${meta.event_id}`;
  return null;
}

export function captionReducer(state: CaptionStoreState, action: CaptionAction): CaptionStoreState {
  switch (action.type) {
    case "reset":
      return INITIAL_CAPTION_STATE;
    case "tentative.user": {
      const clean = action.text.trim();
      return clean ? { ...state, tentativeUserText: clean } : state;
    }
    case "stream.part": {
      const { part, nextId } = action;
      const key = streamKeyFor(part) ?? "default";
      const existing = state.streamMap[key];

      if (part.type === "stop") {
        if (!existing) return state;
        return {
          ...state,
          entries: state.entries.map((entry) =>
            entry.id === existing.captionId ? { ...entry, final: true } : entry,
          ),
        };
      }

      if (part.type !== "delta" || !part.text) return state;
      const nextRaw = `${existing?.raw ?? ""}${part.text}`;
      const clean = stripSpeechTags(nextRaw);
      if (!clean) {
        return {
          ...state,
          streamMap: {
            ...state.streamMap,
            [key]: { captionId: existing?.captionId ?? nextId, raw: nextRaw },
          },
        };
      }

      const captionId = existing?.captionId ?? nextId;
      const idx = state.entries.findIndex((entry) => entry.id === captionId);
      const updatedCaption: VoiceCaption = {
        id: captionId,
        role: "assistant",
        text: clean,
        final: false,
      };
      const nextEntries =
        idx >= 0
          ? state.entries.map((e, i) => (i === idx ? updatedCaption : e))
          : [...state.entries, updatedCaption];

      return {
        ...state,
        entries: nextEntries,
        streamMap: {
          ...state.streamMap,
          [key]: { captionId, raw: nextRaw },
        },
      };
    }
    case "stream.correction": {
      const corrected = action.corr.corrected_agent_response
        ? stripSpeechTags(action.corr.corrected_agent_response)
        : "";
      if (!corrected) return state;
      const key = streamKeyFor(action.corr);
      const tracked = key ? state.streamMap[key] : undefined;
      if (tracked) {
        return {
          ...state,
          entries: state.entries.map((entry) =>
            entry.id === tracked.captionId ? { ...entry, text: corrected, final: true } : entry,
          ),
        };
      }
      for (let i = state.entries.length - 1; i >= 0; i -= 1) {
        const entry = state.entries[i];
        if (entry?.role === "assistant") {
          const copy = [...state.entries];
          copy[i] = { ...entry, text: corrected, final: true };
          return { ...state, entries: copy };
        }
      }
      return state;
    }
    case "final.message": {
      const clean = action.role === "assistant" ? stripSpeechTags(action.text) : action.text.trim();
      if (!clean) return state;

      if (action.role === "user") {
        return {
          ...state,
          tentativeUserText: "",
          entries: [
            ...state.entries,
            { id: action.nextId, role: "user", text: clean, final: true },
          ],
        };
      }

      const tracked = action.streamKey ? state.streamMap[action.streamKey] : undefined;
      if (tracked) {
        const idx = state.entries.findIndex((e) => e.id === tracked.captionId);
        if (idx >= 0) {
          const copy = [...state.entries];
          copy[idx] = { id: tracked.captionId, role: "assistant", text: clean, final: true };
          return { ...state, entries: copy };
        }
      }

      return {
        ...state,
        entries: [
          ...state.entries,
          { id: action.nextId, role: "assistant", text: clean, final: true },
        ],
      };
    }
  }
}
