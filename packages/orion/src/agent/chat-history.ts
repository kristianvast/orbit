import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import { SECRET_PATTERNS } from "@orbit/protocol";

export interface ChatMetadata {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  parentSessionId: string | null;
  deletedAt: string | null;
}

export interface ChatHistory {
  session: ChatMetadata;
  header: SessionHeader | null;
  entries: SessionEntry[];
}

export interface HistoryEntry {
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
}

export interface IncomingHistory {
  session: ChatMetadata;
  header: SessionHeader | null;
  entries: HistoryEntry[];
}

const CREDENTIAL_FILE =
  /(?:^|[/\\\s"'`])(?:\.env(?:[.\w-]*)?|auth\.json|account-session(?:\.enc)?\.json|credentials?(?:\.[\w-]+)?|id_rsa|id_ed25519)(?:$|[/\\\s"'`])/i;
const REDACTED = "[Private credential content omitted from chat sync]";

function scrub(value: unknown): unknown {
  if (typeof value === "string") {
    return SECRET_PATTERNS.some((p) => p.test(value)) ||
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(value)
      ? REDACTED
      : value;
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        typeof v === "string" &&
        /^(?:pass(?:word|wd)?|secret|api[_-]?key|token|credential|access[_-]?token|refresh[_-]?token)\w*$/i.test(
          k,
        )
          ? REDACTED
          : scrub(v),
      ]),
    );
  return value;
}

/** Keep entry IDs and parents, but never relay known credentials or reads of credential files. */
export function cloudEntries(entries: SessionEntry[]): Record<string, unknown>[] {
  const privateCalls = new Set<string>();
  for (const e of entries) {
    if (e.type !== "message" || e.message.role !== "assistant") continue;
    for (const block of e.message.content) {
      if (block.type === "toolCall" && CREDENTIAL_FILE.test(JSON.stringify(block.arguments)))
        privateCalls.add(block.id);
    }
  }
  return entries.map((e) => {
    const safe =
      e.type === "message" &&
      e.message.role === "toolResult" &&
      privateCalls.has(e.message.toolCallId)
        ? {
            ...e,
            message: {
              ...e.message,
              content: [{ type: "text", text: REDACTED }],
              details: undefined,
            },
          }
        : e;
    const clean = scrub(safe);
    if (clean && typeof clean === "object" && !Array.isArray(clean)) return { ...clean };
    throw new TypeError("chat entry must be an object");
  });
}

/** Stable parent-before-child order gives every install the same default branch. */
export function mergeEntries(local: HistoryEntry[], remote: HistoryEntry[]): HistoryEntry[] {
  const entries = new Map([...remote, ...local].map((e) => [e.id, e]));
  const ordered: HistoryEntry[] = [];
  const visited = new Set<string>();
  const visit = (e: HistoryEntry) => {
    if (visited.has(e.id)) return;
    visited.add(e.id);
    const parent = e.parentId ? entries.get(e.parentId) : undefined;
    if (parent) visit(parent);
    ordered.push(e);
  };
  [...entries.values()]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))
    .forEach(visit);
  return ordered;
}
