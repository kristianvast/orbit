import type { VoiceTransport } from "./transport";

/** Mutable lifecycle state shared by connection ownership and the serialized frame receiver. */
export type VoiceSessionState = {
  readonly voiceId: string;
  readonly sessionId: string;
  readonly owner: object;
  readonly transport: VoiceTransport;
  readonly cancelled: Set<string>;
  active: boolean;
  ready: boolean;
  queue: Promise<void>;
};
