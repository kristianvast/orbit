import type {
  AssistantItem,
  SessionSummary,
  SystemItem,
  ToolItem,
  TranscriptItem,
  UserItem,
} from "@orbit/protocol";
import type { MessageKey, TranslateFn } from "../../i18n";

export interface Turn {
  id: string;
  user: UserItem | null;
  steps: Array<AssistantItem | ToolItem | SystemItem>;
}

export type TurnBlock =
  | { kind: "tools"; id: string; tools: ToolItem[] }
  | { kind: "step"; item: AssistantItem | SystemItem };

const MIN_WORKED_MS = 1_000;

export function buildTurns(items: readonly TranscriptItem[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const item of items) {
    if (item.kind === "user") {
      current = { id: item.id, user: item, steps: [] };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = { id: `lead-${item.id}`, user: null, steps: [] };
      turns.push(current);
    }
    current.steps.push(item);
  }
  return turns;
}

export function buildTurnBlocks(steps: Turn["steps"]): TurnBlock[] {
  const blocks: TurnBlock[] = [];
  for (const step of steps) {
    if (step.kind === "tool") {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "tools") last.tools.push(step);
      else blocks.push({ kind: "tools", id: `tools-${step.id}`, tools: [step] });
    } else {
      blocks.push({ kind: "step", item: step });
    }
  }
  return blocks;
}

/**
 * Elapsed time from the prompt to the turn's last step, from real timestamps only.
 * Null when the turn has no work yet, timestamps are missing, or it took under a second.
 */
export function turnDurationMs(turn: Turn): number | null {
  if (!turn.user || turn.steps.length === 0) return null;
  const start = Date.parse(turn.user.ts);
  if (Number.isNaN(start)) return null;
  let end: number | null = null;
  for (const step of turn.steps) {
    const t = Date.parse(step.ts);
    if (Number.isNaN(t)) continue;
    const stepEnd = step.kind === "tool" && step.durationMs ? t + step.durationMs : t;
    end = end === null ? stepEnd : Math.max(end, stepEnd);
  }
  if (end === null || end - start < MIN_WORKED_MS) return null;
  return end - start;
}

export function formatElapsed(ms: number, t: TranslateFn): string {
  const seconds = Math.max(1, Math.floor(ms / 1000));
  if (seconds < 60) return t("chat.elapsed.seconds", { seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0
    ? t("chat.elapsed.minutes", { minutes })
    : t("chat.elapsed.minutesSeconds", { minutes, seconds: rest });
}

export type RecencyBucket = "today" | "yesterday" | "week" | "older";

export const RECENCY_LABELS: Record<RecencyBucket, MessageKey> = {
  today: "chat.recency.today",
  yesterday: "chat.recency.yesterday",
  week: "chat.recency.week",
  older: "chat.recency.older",
};

const BUCKET_ORDER: RecencyBucket[] = ["today", "yesterday", "week", "older"];

export type ToolActivityKind =
  | "commands"
  | "filesRead"
  | "filesChanged"
  | "filesSearched"
  | "screen"
  | "web"
  | "farm"
  | "other";

export const TOOL_KIND_LABELS: Record<ToolActivityKind, MessageKey> = {
  commands: "chat.timeline.kind.commands",
  filesRead: "chat.timeline.kind.filesRead",
  filesChanged: "chat.timeline.kind.filesChanged",
  filesSearched: "chat.timeline.kind.filesSearched",
  screen: "chat.timeline.kind.screen",
  web: "chat.timeline.kind.web",
  farm: "chat.timeline.kind.farm",
  other: "chat.timeline.kind.other",
};

export function classifyToolKind(name: string): ToolActivityKind {
  switch (name) {
    case "bash":
    case "powershell":
      return "commands";
    case "read":
      return "filesRead";
    case "write":
    case "edit":
      return "filesChanged";
    case "ls":
    case "find":
    case "grep":
      return "filesSearched";
    case "computer":
      return "screen";
    case "web_search":
    case "web_fetch":
    case "browser":
      return "web";
    case "herd_query":
    case "herd_upsert_animal":
    case "herd_record_event":
    case "devices_list":
    case "device_bind":
    case "observations_query":
    case "connectors_list":
    case "connector_scaffold":
    case "connector_configure":
    case "connector_run":
    case "connector_remove":
    case "camera_discover":
    case "camera_add":
    case "db_query":
    case "db_mutate":
      return "farm";
    default:
      return "other";
  }
}

export interface ToolKindCount {
  kind: ToolActivityKind;
  labelKey: MessageKey;
  count: number;
}

export interface ToolActivitySummary {
  total: number;
  failed: number;
  kinds: ToolKindCount[];
}

export function summarizeToolGroup(tools: readonly ToolItem[]): ToolActivitySummary {
  const counts = new Map<ToolActivityKind, number>();
  const firstSeen = new Map<ToolActivityKind, number>();
  let failed = 0;

  tools.forEach((tool, idx) => {
    if (tool.status === "error") failed += 1;
    const kind = classifyToolKind(tool.name);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (!firstSeen.has(kind)) firstSeen.set(kind, idx);
  });

  const kinds: ToolKindCount[] = [...counts.entries()]
    .map(([kind, count]) => ({
      kind,
      labelKey: TOOL_KIND_LABELS[kind],
      count,
    }))
    .sort((a, b) => {
      if (a.kind === "other" && b.kind !== "other") return 1;
      if (b.kind === "other" && a.kind !== "other") return -1;
      if (b.count !== a.count) return b.count - a.count;
      return (firstSeen.get(a.kind) ?? 0) - (firstSeen.get(b.kind) ?? 0);
    });

  return {
    total: tools.length,
    failed,
    kinds,
  };
}

export interface CollapsedToolRun {
  key: string;
  item: ToolItem;
  argSummary: string;
  count: number;
  items: ToolItem[];
}

export function collapseToolRuns(
  tools: readonly ToolItem[],
  summarizeArgs: (tool: ToolItem) => string,
): CollapsedToolRun[] {
  const runs: CollapsedToolRun[] = [];
  for (const tool of tools) {
    const argSummary = summarizeArgs(tool);
    const prev = runs[runs.length - 1];
    if (prev && prev.item.name === tool.name && prev.argSummary === argSummary) {
      prev.count += 1;
      prev.items.push(tool);
      const totalDuration = prev.items.reduce(
        (sum, entry) => sum + (typeof entry.durationMs === "number" ? entry.durationMs : 0),
        0,
      );
      const hasDuration = prev.items.some((entry) => typeof entry.durationMs === "number");
      const hasRunning = prev.items.some((entry) => entry.status === "running");
      const hasError = prev.items.some((entry) => entry.status === "error");
      const status: ToolItem["status"] = hasRunning ? "running" : hasError ? "error" : tool.status;
      prev.item = {
        ...tool,
        status,
        ...(hasDuration ? { durationMs: totalDuration } : {}),
      };
    } else {
      runs.push({
        key: tool.id,
        item: tool,
        argSummary,
        count: 1,
        items: [tool],
      });
    }
  }
  return runs;
}

/** Picks the newest running tool, or the last finished tool in the group. */
export function selectLiveTool(tools: readonly ToolItem[]): ToolItem | null {
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i];
    if (tool && tool.status === "running") return tool;
  }
  return tools[tools.length - 1] ?? null;
}

function bucketOf(iso: string, now: Date): RecencyBucket {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "older";
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  if (t >= startOfToday) return "today";
  if (t >= startOfToday - day) return "yesterday";
  if (t >= startOfToday - 7 * day) return "week";
  return "older";
}

export function groupSessionsByRecency(
  sessions: readonly SessionSummary[],
  now: Date = new Date(),
): Array<{ bucket: RecencyBucket; labelKey: MessageKey; sessions: SessionSummary[] }> {
  const sorted = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const byBucket = new Map<RecencyBucket, SessionSummary[]>();
  for (const s of sorted) {
    const b = bucketOf(s.updatedAt, now);
    const list = byBucket.get(b);
    if (list) list.push(s);
    else byBucket.set(b, [s]);
  }
  return BUCKET_ORDER.flatMap((bucket) => {
    const list = byBucket.get(bucket);
    return list ? [{ bucket, labelKey: RECENCY_LABELS[bucket], sessions: list }] : [];
  });
}

/**
 * A conversation belongs in history once something was said in it. Empty sessions
 * (created but never prompted) stay hidden unless they are open or running.
 */
export function isListedSession(session: SessionSummary, activeId: string | null): boolean {
  return session.messageCount > 0 || session.streaming || session.id === activeId;
}
