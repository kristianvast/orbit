import { Value } from "typebox/value";
import { RepoError } from "../db/repo";
import { AccountError } from "../services/account";
import type { VoiceOptions } from "./session";
import type { VoiceSessionState } from "./state";
import { runVoiceTool } from "./tools";
import { VoiceFrame } from "./wire";

/** Translate Gemini frames and execute named farm operations in upstream order. */
export async function receiveVoiceFrame(
  live: VoiceSessionState,
  raw: unknown,
  opts: Pick<VoiceOptions, "farm" | "emit">,
): Promise<void> {
  if (!live.active) return;
  if (!Value.Check(VoiceFrame, raw))
    throw new AccountError("bad_request", "Invalid voice service message.");
  const ref = { voiceId: live.voiceId, sessionId: live.sessionId };
  if (raw.error) throw new AccountError("not_ready", raw.error.message);
  if (raw.setupComplete !== undefined) {
    live.ready = true;
    opts.emit("voice.state", { ...ref, state: "listening" });
  }
  const content = raw.serverContent;
  if (content) {
    if (content.interrupted) opts.emit("voice.state", { ...ref, state: "listening" });
    for (const part of content.modelTurn?.parts ?? []) {
      if (part.inlineData?.mimeType.startsWith("audio/pcm")) {
        opts.emit("voice.state", { ...ref, state: "speaking" });
        opts.emit("voice.audio", { ...ref, data: part.inlineData.data, sampleRate: 24000 });
      }
    }
    for (const [role, transcript] of [
      ["user", content.inputTranscription],
      ["assistant", content.outputTranscription],
    ] as const) {
      if (transcript)
        opts.emit("voice.transcript", {
          ...ref,
          role,
          text: transcript.text,
          final: transcript.finished ?? content.turnComplete ?? false,
        });
    }
    if (content.turnComplete) opts.emit("voice.state", { ...ref, state: "listening" });
  }
  for (const call of raw.toolCall?.functionCalls ?? []) {
    if (!live.active || live.cancelled.has(call.id)) continue;
    opts.emit("voice.tool", {
      ...ref,
      toolCallId: call.id,
      name: call.name,
      args: call.args,
      state: "running",
    });
    let response: unknown;
    let isError = false;
    try {
      response = { result: await runVoiceTool(opts.farm, call, live.sessionId) };
    } catch (error) {
      if (!(error instanceof AccountError) && !(error instanceof RepoError)) throw error;
      response = { error: { code: error.code, message: error.message } };
      isError = true;
    }
    if (!live.active || live.cancelled.has(call.id)) continue;
    opts.emit("voice.tool", {
      ...ref,
      toolCallId: call.id,
      name: call.name,
      state: "done",
      result: JSON.stringify(response),
      isError,
    });
    live.transport.send({
      toolResponse: { functionResponses: [{ id: call.id, name: call.name, response }] },
    });
  }
}
