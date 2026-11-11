import { Type } from "typebox";
import { Value } from "typebox/value";
import type { VoiceTransport } from "./transport";

const UserInput = Type.Object({ type: Type.Literal("user_message"), text: Type.String() });
const ToolResult = Type.Object({
  type: Type.Literal("client_tool_result"),
  tool_call_id: Type.String(),
  result: Type.String(),
  is_error: Type.Optional(Type.Boolean()),
});
const Herd = Type.Object({ total: Type.Number() });
type Result = { readonly result: string; readonly is_error?: boolean };

/** Deterministic ElevenLabs client-tool peer; no audio or upstream credentials. */
export class MockVoiceTransport implements VoiceTransport {
  private receive: ((frame: string) => void) | null = null;
  private initiated = false;
  private sequence = 0;
  private eventId = 0;
  private readonly waiting = new Map<string, (result: Result) => void>();

  async connect(receive: (frame: string) => void): Promise<void> {
    this.receive = receive;
  }
  close(): void {
    this.receive = null;
    this.waiting.clear();
  }
  private deliver(frame: unknown): void {
    this.receive?.(JSON.stringify(frame));
  }
  private say(text: string): void {
    this.deliver({
      type: "agent_response",
      agent_response_event: { agent_response: text, event_id: ++this.eventId },
    });
  }
  private tool(name: string, parameters: unknown, then: (result: Result) => void): void {
    const id = `mock-${++this.sequence}`;
    this.waiting.set(id, then);
    this.deliver({
      type: "client_tool_call",
      client_tool_call: { tool_name: name, tool_call_id: id, parameters },
    });
  }

  send(frame: string): void {
    if (!this.initiated) {
      this.initiated = true;
      this.deliver({
        type: "conversation_initiation_metadata",
        conversation_initiation_metadata_event: {
          conversation_id: `mock-${crypto.randomUUID()}`,
          agent_output_audio_format: "pcm_16000",
          user_input_audio_format: "pcm_16000",
        },
      });
      this.say("Hello, Orion here. How can I help?");
    }
    let input: unknown;
    try {
      input = JSON.parse(frame);
    } catch (error) {
      if (error instanceof SyntaxError) return;
      throw error;
    }
    if (Value.Check(ToolResult, input)) {
      const then = this.waiting.get(input.tool_call_id);
      this.waiting.delete(input.tool_call_id);
      then?.(input);
    } else if (Value.Check(UserInput, input)) this.respond(input.text);
  }

  private respond(text: string): void {
    if (text.startsWith("[Orion update]")) {
      this.say(`Good news. ${text.slice("[Orion update]".length).trim()}`);
    } else if (/\bopen settings\b/i.test(text) || /settings/i.test(text)) {
      const click = /\bopen settings\b/i.test(text);
      this.tool("app", { action: "look" }, ({ result }) => {
        const ref = /^\[(\d+)\] .*settings/im.exec(result)?.[1];
        if (!ref) {
          this.say("I could not find Settings on this screen.");
          return;
        }
        this.tool(
          "app",
          {
            action: click ? "click" : "highlight",
            ref: Number(ref),
            ...(click ? {} : { note: "Settings are here." }),
          },
          () =>
            this.say(
              click
                ? "I opened Settings for you."
                : "Settings are in the menu. I marked it for you.",
            ),
        );
      });
    } else if (/https?:\/\/\S+/.test(text)) {
      const url = /https?:\/\/\S+/.exec(text)?.[0];
      this.tool("browser", { action: "open", url }, () =>
        this.tool("browser", { action: "highlight", ref: 1, note: "Start here." }, () =>
          this.say("I opened the page and marked where to start."),
        ),
      );
    } else if (/\b(build|make|create)\b/i.test(text)) {
      this.tool("orion_task", { request: text }, () =>
        this.say("I have started on that. I will tell you when it is ready."),
      );
    } else {
      this.tool("db_query", { query: "animals.list", params: {} }, (reply) => {
        let herd: unknown;
        try {
          herd = JSON.parse(reply.result);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
        this.say(
          !reply.is_error && Value.Check(Herd, herd)
            ? `There are ${herd.total} animals in your herd. I checked the records on this computer.`
            : "I could not read the herd records.",
        );
      });
    }
  }
}
