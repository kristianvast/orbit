import { Type } from "typebox";

const Ref = { sessionId: Type.String(), voiceId: Type.String() };
const VoiceRef = { voiceId: Type.String() };
const Accepted = Type.Object({ accepted: Type.Boolean() });
/** PCM16 little endian mono, encoded as base64; at most 64 KiB per input frame. */
const Audio = Type.String({ minLength: 4, maxLength: 87384, pattern: "^[A-Za-z0-9+/]+={0,2}$" });

export const VoiceRequests = {
  "voice.start": {
    params: Type.Object({ sessionId: Type.String() }),
    result: Type.Object(VoiceRef),
  },
  "voice.stop": { params: Type.Object(VoiceRef), result: Accepted },
  "voice.audio": {
    params: Type.Object({ ...VoiceRef, data: Audio }),
    result: Accepted,
  },
  /** Typed input is useful alongside the microphone and in the mock-model development path. */
  "voice.text": {
    params: Type.Object({ ...VoiceRef, text: Type.String({ minLength: 1, maxLength: 10000 }) }),
    result: Accepted,
  },
} as const;

export const VoiceEvents = {
  "voice.state": Type.Object({
    ...Ref,
    state: Type.Enum(["connecting", "listening", "speaking", "stopped"]),
    error: Type.Optional(Type.String()),
  }),
  "voice.audio": Type.Object({ ...Ref, data: Audio, sampleRate: Type.Literal(24000) }),
  "voice.transcript": Type.Object({
    ...Ref,
    role: Type.Enum(["user", "assistant"]),
    text: Type.String(),
    final: Type.Boolean(),
  }),
  "voice.tool": Type.Object({
    ...Ref,
    toolCallId: Type.String(),
    name: Type.String(),
    state: Type.Enum(["running", "done"]),
    args: Type.Optional(Type.Unknown()),
    result: Type.Optional(Type.String()),
    isError: Type.Optional(Type.Boolean()),
  }),
} as const;
