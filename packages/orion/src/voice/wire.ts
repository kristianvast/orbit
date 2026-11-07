import { type Static, Type } from "typebox";

const Transcription = Type.Object({ text: Type.String(), finished: Type.Optional(Type.Boolean()) });
export const VoiceFrame = Type.Object({
  setupComplete: Type.Optional(Type.Unknown()),
  serverContent: Type.Optional(
    Type.Object({
      inputTranscription: Type.Optional(Transcription),
      outputTranscription: Type.Optional(Transcription),
      turnComplete: Type.Optional(Type.Boolean()),
      interrupted: Type.Optional(Type.Boolean()),
      modelTurn: Type.Optional(
        Type.Object({
          parts: Type.Array(
            Type.Object({
              text: Type.Optional(Type.String()),
              inlineData: Type.Optional(
                Type.Object({ data: Type.String(), mimeType: Type.String() }),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
  toolCall: Type.Optional(
    Type.Object({
      functionCalls: Type.Array(
        Type.Object({
          id: Type.String(),
          name: Type.String(),
          args: Type.Unknown(),
        }),
      ),
    }),
  ),
  toolCallCancellation: Type.Optional(Type.Object({ ids: Type.Array(Type.String()) })),
  error: Type.Optional(Type.Object({ message: Type.String() })),
});
export type VoiceFrame = Static<typeof VoiceFrame>;
