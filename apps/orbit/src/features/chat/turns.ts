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
