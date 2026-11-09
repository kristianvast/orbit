// Deterministic local model for UI development and e2e tests (--mock-model / ORION_MOCK_MODEL=1).
// Registered through Pi's custom-provider mechanism (ModelRuntime.registerProvider + streamSimple).
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Message,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const MOCK_PROVIDER = "orion-mock";
export const MOCK_MODEL = "mock-1";

export interface MockTrigger {
  match: RegExp;
  tool: string;
  args: Record<string, unknown>;
}

/** Prompts that make the mock call a tool; everything else gets a streamed echo reply. */
export const MOCK_TRIGGERS: MockTrigger[] = [
  { match: /list cows/i, tool: "herd_query", args: { species: "cattle" } },
  { match: /find cameras/i, tool: "camera_discover", args: { timeoutMs: 1500 } },
  { match: /build my orbit/i, tool: "local_ui_build", args: {} },
  { match: /find a skill for delaval/i, tool: "skill_search", args: { query: "delaval" } },
  { match: /install the delaval skill/i, tool: "skill_install", args: { name: "delaval-delpro" } },
  {
    match: /set up the delaval connector/i,
    tool: "connector_scaffold",
    args: { name: "delpro", fromSkill: "delaval-delpro" },
  },
  {
    match: /write a note/i,
    tool: "write",
    args: {
      path: "notes/orion-note.md",
      content: "# Note from Orion\n\nWritten by the mock model.\n",
    },
  },
  {
    match: /make a page/i,
    tool: "write",
    args: {
      path: "pages/herd-count/index.html",
      content: [
        "<!doctype html>",
        '<html><head><meta charset="utf-8"><title>Herd count</title></head>',
        '<body><h1>Herd count</h1><p id="count">Loading...</p>',
        '<script src="../_orbit.js"></script>',
        "<script>",
        "orbit.query('farm.summary').then((s) => {",
        "  document.getElementById('count').textContent = s.counts.cattle + ' cattle';",
        "});",
        "</script></body></html>",
        "",
      ].join("\n"),
    },
  },
  {
    // "herd" plus one of track / add / set up, in any order (e.g. "Help me track my herd").
    match: /^(?=[\s\S]*\bherd\b)(?=[\s\S]*\b(?:track|add|set up)\b)/i,
    tool: "orbit_modules",
    args: { action: "enable", id: "herd" },
  },
];

function textOf(message: Message | undefined): string {
  if (!message) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
      .map((c) => c.text)
      .join("");
  }
  return "";
}

function replyFor(messages: Message[]): { text: string } | { call: ToolCall } {
  const last = messages[messages.length - 1];
  if (last?.role === "toolResult") {
    const result = textOf(last);
    const isError = (last as { isError?: boolean }).isError === true;
    const firstLines = result.split("\n").slice(0, 6).join("\n");
    return {
      text: isError
        ? `That did not work: ${firstLines}`
        : `Here is what I found:\n${firstLines}\nAsk me if you want more detail.`,
    };
  }
  const prompt = textOf(last);
  const trigger = MOCK_TRIGGERS.find((t) => t.match.test(prompt));
  if (trigger) {
    const index = messages.filter((m) => m.role === "assistant").length;
    return {
      call: {
        type: "toolCall",
        id: `mock_call_${index}_${trigger.tool}`,
        name: trigger.tool,
        arguments: trigger.args as ToolCall["arguments"],
      },
    };
  }
  return {
    text: `This is the Orion mock model. You said: "${prompt.trim()}". I can help with your herd.`,
  };
}

export function registerMockProvider(
  runtime: ModelRuntime,
  delayMs = Number(process.env.ORION_MOCK_DELAY_MS ?? 10),
) {
  runtime.registerProvider(MOCK_PROVIDER, {
    name: "Orion mock",
    baseUrl: "http://127.0.0.1/mock",
    apiKey: "mock",
    api: MOCK_PROVIDER as Api,
    models: [
      {
        id: MOCK_MODEL,
        name: "Mock model (offline)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4096,
      },
    ],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      const signal = options?.signal;
      const aborted = () => {
        message.stopReason = "aborted";
        message.errorMessage = "aborted";
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end();
      };
      (async () => {
        stream.push({ type: "start", partial: message });
        const reply = replyFor(context.messages);
        if ("call" in reply) {
          message.content.push(reply.call);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({
            type: "toolcall_delta",
            contentIndex: 0,
            delta: JSON.stringify(reply.call.arguments),
            partial: message,
          });
          stream.push({
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: reply.call,
            partial: message,
          });
          message.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message });
          stream.end();
          return;
        }
        const block = { type: "text" as const, text: "" };
        message.content.push(block);
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        for (const word of reply.text.split(/(?<=\s)/)) {
          if (signal?.aborted) return aborted();
          block.text += word;
          stream.push({ type: "text_delta", contentIndex: 0, delta: word, partial: message });
          if (delayMs > 0) await Bun.sleep(delayMs);
        }
        stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: message });
        message.usage.output = block.text.split(/\s+/).length;
        message.usage.totalTokens = message.usage.output;
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      })();
      return stream;
    },
  });
}
