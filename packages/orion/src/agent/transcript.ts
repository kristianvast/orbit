import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantItem, ToolItem, TranscriptItem, UserItem } from "@orbit/protocol";

type AnyMessage = { role: string; content?: unknown; timestamp?: number } & Record<string, unknown>;

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => (c as { type?: string }).type === "text")
    .map((c) => (c as { text: string }).text)
    .join("");
}

function thinkingText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => (c as { type?: string }).type === "thinking")
    .map((c) => (c as { thinking: string }).thinking)
    .join("");
}

const isoOf = (ms: number | undefined, fallback: string) =>
  typeof ms === "number" ? new Date(ms).toISOString() : fallback;

export function userItem(id: string, message: AnyMessage, fallbackTs: string): UserItem {
  return {
    kind: "user",
    id,
    ts: isoOf(message.timestamp, fallbackTs),
    text: contentText(message.content),
  };
}

export function assistantItem(id: string, message: AnyMessage, fallbackTs: string): AssistantItem {
  const thinking = thinkingText(message.content);
  const item: AssistantItem = {
    kind: "assistant",
    id,
    ts: isoOf(message.timestamp, fallbackTs),
    text: contentText(message.content),
  };
  if (thinking) item.thinking = thinking;
  if (typeof message.model === "string")
    item.model = `${String(message.provider ?? "")}/${message.model}`;
  if (typeof message.stopReason === "string") item.stopReason = message.stopReason;
  if (typeof message.errorMessage === "string") item.errorMessage = message.errorMessage;
  return item;
}

export function toolStatus(isError: boolean): ToolItem["status"] {
  return isError ? "error" : "done";
}

/** Converts the active branch of a Pi session into UI transcript items, oldest first. */
export function buildTranscript(
  entries: SessionEntry[],
  labelOf: (toolName: string) => string,
  streaming: boolean,
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const tools = new Map<string, ToolItem>();
  for (const entry of entries) {
    if (entry.type === "compaction") {
      items.push({
        kind: "system",
        id: entry.id,
        ts: entry.timestamp,
        text: "Earlier messages were summarized to save space.",
      });
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message as unknown as AnyMessage;
    if (message.role === "user") {
      items.push(userItem(entry.id, message, entry.timestamp));
    } else if (message.role === "assistant") {
      const item = assistantItem(entry.id, message, entry.timestamp);
      if (item.text || item.thinking || item.errorMessage) items.push(item);
      for (const block of (Array.isArray(message.content) ? message.content : []) as Array<
        Record<string, unknown>
      >) {
        if (block.type !== "toolCall") continue;
        const tool: ToolItem = {
          kind: "tool",
          id: String(block.id),
          ts: item.ts,
          toolCallId: String(block.id),
          name: String(block.name),
          label: labelOf(String(block.name)),
          args: block.arguments ?? {},
          status: "running",
        };
        tools.set(tool.toolCallId, tool);
        items.push(tool);
      }
    } else if (message.role === "toolResult") {
      const tool = tools.get(String(message.toolCallId));
      if (!tool) continue;
      const result = contentText(message.content);
      const isError = message.isError === true;
      tool.result = result;
      tool.details = message.details;
      tool.isError = isError;
      tool.status = toolStatus(isError);
      if (typeof message.durationMs === "number") tool.durationMs = message.durationMs;
    }
  }
  if (!streaming) {
    for (const tool of tools.values()) if (tool.status === "running") tool.status = "aborted";
  }
  return items;
}
