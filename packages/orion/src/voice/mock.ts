import { Type } from "typebox";
import { Value } from "typebox/value";
import type { VoiceTransport } from "./transport";

const Input = Type.Object({ realtimeInput: Type.Object({ text: Type.Optional(Type.String()) }) });
const ToolResult = Type.Object({
  toolResponse: Type.Object({
    functionResponses: Type.Array(
      Type.Object({
        response: Type.Unknown(),
      }),
    ),
  }),
});
const HerdResult = Type.Object({ result: Type.Object({ total: Type.Number() }) });

/** Deterministic Gemini protocol peer for --mock-model; executes the real farm tool path. */
export class MockVoiceTransport implements VoiceTransport {
  private receive: ((frame: unknown) => void) | null = null;
  readonly sent: unknown[] = [];

  async connect(receive: (frame: unknown) => void): Promise<void> {
    this.receive = receive;
  }

  send(frame: unknown): void {
    this.sent.push(frame);
    if (Value.Check(Input, frame)) {
      if (!frame.realtimeInput.text) return;
      this.receive?.({ serverContent: { inputTranscription: { text: frame.realtimeInput.text } } });
      this.receive?.({
        toolCall: {
          functionCalls: [
            {
              id: crypto.randomUUID(),
              name: "db_query",
              args: { query: "animals.list", params: {} },
            },
          ],
        },
      });
    } else if (Value.Check(ToolResult, frame)) {
      const result = frame.toolResponse.functionResponses[0]?.response;
      const text = Value.Check(HerdResult, result)
        ? `There are ${result.result.total} animals in your herd. I checked the records on this computer.`
        : "I checked the farm records.";
      this.receive?.({
        serverContent: {
          outputTranscription: { text },
          turnComplete: true,
        },
      });
    } else {
      this.receive?.({ setupComplete: {} });
    }
  }

  /** Feed upstream function calls through the same receiver as a live socket. */
  deliver(frame: unknown): void {
    this.receive?.(frame);
  }
  close(): void {
    this.receive = null;
  }
}
