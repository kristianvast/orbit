import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { assertNever } from "../services/camera-proxy";

export type VoiceMessage = (UserMessage | AssistantMessage) & {
  readonly voice: true;
  readonly voiceItemId: string;
};

export type TaskOutcome = {
  readonly reason: "completed" | "aborted" | "error";
  readonly text: string;
};

export function voiceMessage(role: "user" | "assistant", text: string): VoiceMessage {
  const common = {
    content: [{ type: "text" as const, text }],
    timestamp: Date.now(),
    voice: true as const,
    voiceItemId: `voice_${crypto.randomUUID()}`,
  };
  switch (role) {
    case "user":
      return { ...common, role };
    case "assistant":
      return {
        ...common,
        role,
        api: "openai-completions",
        provider: "orbit-voice",
        model: "voice",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
      };
    default:
      return assertNever(role);
  }
}
