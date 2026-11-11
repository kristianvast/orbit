import { Type } from "typebox";

const VoiceRef = { voiceId: Type.String() };
const Accepted = Type.Object({ accepted: Type.Boolean() });

/** The tools the voice agent may ask Orion to run beside the farm database. */
export const VOICE_TOOL_NAMES = ["db_query", "db_mutate", "browser", "orion_task"] as const;
export type VoiceToolName = (typeof VOICE_TOOL_NAMES)[number];

export const VoiceRequests = {
  /**
   * Opens a voice call in a conversation. The app then connects the voice SDK to `path` on
   * Orion's own origin; Orion relays that socket to the voice service. No key reaches the app.
   */
  "voice.start": {
    params: Type.Object({ sessionId: Type.String() }),
    result: Type.Object({
      ...VoiceRef,
      /** WebSocket path on Orion's HTTP origin that speaks the voice agent protocol. Carries the session token. */
      path: Type.String(),
      /** Values for the agent's prompt placeholders: farm_name and conversation_recap. */
      variables: Type.Record(Type.String(), Type.String()),
    }),
  },
  "voice.stop": { params: Type.Object(VoiceRef), result: Accepted },
  /** One finished spoken or typed turn. Saved in the conversation like a chat message. */
  "voice.turn": {
    params: Type.Object({
      ...VoiceRef,
      role: Type.Enum(["user", "assistant"]),
      text: Type.String({ minLength: 1, maxLength: 10000 }),
    }),
    result: Accepted,
  },
  /**
   * Runs a tool the voice agent asked for. Work that outlasts the answer comes back as "started",
   * and its outcome follows later as a voice.note.
   */
  "voice.tool": {
    params: Type.Object({
      ...VoiceRef,
      toolCallId: Type.String({ minLength: 1, maxLength: 200 }),
      name: Type.Enum([...VOICE_TOOL_NAMES]),
      args: Type.Unknown(),
    }),
    result: Type.Object({
      /** What the agent is told: the outcome in plain text, or JSON for farm records. */
      result: Type.String(),
      isError: Type.Boolean(),
    }),
  },
} as const;

export const VoiceEvents = {
  /** Something the voice agent should be told mid-call, such as a finished background job. */
  "voice.note": Type.Object({
    sessionId: Type.String(),
    ...VoiceRef,
    text: Type.String(),
  }),
  /** The page Orion's browser shows, so the farmer can follow along. A null image means it closed. */
  "browser.view": Type.Object({
    sessionId: Type.String(),
    url: Type.String(),
    title: Type.String(),
    /** JPEG, base64. */
    image: Type.Union([Type.String(), Type.Null()]),
    width: Type.Integer(),
    height: Type.Integer(),
    /** Where Orion is pointing, in page pixels of the picture. */
    highlight: Type.Union([
      Type.Object({
        x: Type.Number(),
        y: Type.Number(),
        width: Type.Number(),
        height: Type.Number(),
        note: Type.Optional(Type.String()),
      }),
      Type.Null(),
    ]),
  }),
} as const;
