import type { EventFrame } from "@orbit/protocol";
import type { TranslateFn } from "../../i18n";
import type { ActivityRecord, ActivityStatus } from "./types";

export { describeActivityRecord, isCleanPlainSentence } from "./activity-copy";

export type ActivityAction =
  | { readonly type: "reset" }
  | { readonly type: "tool.start"; readonly ev: EventFrame<"tool.start">; readonly now: number }
  | { readonly type: "tool.update"; readonly ev: EventFrame<"tool.update"> }
  | { readonly type: "tool.end"; readonly ev: EventFrame<"tool.end">; readonly now: number }
  | {
      readonly type: "agent.settled";
      readonly ev: EventFrame<"agent.settled">;
      readonly now: number;
    }
  | { readonly type: "voice.note"; readonly now: number; readonly text?: string }
  | {
      readonly type: "app.start";
      readonly id: string;
      readonly args: unknown;
      readonly now: number;
    }
  | {
      readonly type: "app.end";
      readonly id: string;
      readonly result: string;
      readonly isError: boolean;
      readonly now: number;
    }
  | { readonly type: "task.stopped"; readonly now: number };

function isHandedOverStillRunning(
  name: string,
  result: string | undefined,
  isError: boolean,
): boolean {
  if (name !== "orion_task" || isError) return false;
  const trimmed = (result ?? "").trim().toLowerCase();
  return trimmed === "started" || trimmed.startsWith("still working on it");
}

function upsertRecord(state: readonly ActivityRecord[], next: ActivityRecord): ActivityRecord[] {
  const idx = state.findIndex((r) => r.id === next.id);
  if (idx < 0) return [...state, next];
  const copy = [...state];
  copy[idx] = next;
  return copy;
}

export function activityReducer(
  state: readonly ActivityRecord[],
  action: ActivityAction,
): ActivityRecord[] {
  switch (action.type) {
    case "reset":
      return [];
    case "tool.start": {
      const { ev, now } = action;
      const existing = state.find((r) => r.id === ev.toolCallId);
      return upsertRecord(state, {
        id: ev.toolCallId,
        name: ev.name,
        label: ev.label,
        args: ev.args,
        status: "running",
        startedAt: existing?.startedAt ?? now,
        handedOver: ev.name === "orion_task",
      });
    }
    case "tool.update": {
      const cur = state.find((r) => r.id === action.ev.toolCallId);
      return cur ? upsertRecord(state, { ...cur, result: action.ev.partial }) : [...state];
    }
    case "tool.end": {
      const { ev, now } = action;
      const cur = state.find((r) => r.id === ev.toolCallId);
      const name = cur?.name ?? "unknown";
      const wasStopped =
        cur?.status === "stopped" ||
        (name === "orion_task" && ev.result.trim() === "It was stopped.");
      if (!wasStopped && isHandedOverStillRunning(name, ev.result, ev.isError)) {
        return upsertRecord(state, {
          id: ev.toolCallId,
          name,
          ...(cur?.label !== undefined ? { label: cur.label } : {}),
          ...(cur?.args !== undefined ? { args: cur.args } : {}),
          status: "running",
          startedAt: cur?.startedAt ?? now,
          handedOver: true,
        });
      }
      const nextStatus: ActivityStatus = wasStopped ? "stopped" : ev.isError ? "error" : "done";
      return upsertRecord(state, {
        id: ev.toolCallId,
        name,
        ...(cur?.label !== undefined ? { label: cur.label } : {}),
        ...(cur?.args !== undefined ? { args: cur.args } : {}),
        status: nextStatus,
        startedAt: cur?.startedAt ?? now,
        endedAt: cur?.endedAt ?? now,
        ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
        result: ev.result,
        ...(ev.details !== undefined ? { details: ev.details } : {}),
        handedOver: cur?.handedOver ?? name === "orion_task",
      });
    }
    case "agent.settled": {
      const settledStatus: ActivityStatus =
        action.ev.reason === "aborted"
          ? "stopped"
          : action.ev.reason === "error"
            ? "error"
            : "done";
      return state.map((row) =>
        row.status === "running" ? { ...row, status: settledStatus, endedAt: action.now } : row,
      );
    }
    case "voice.note": {
      const noteStopped = action.text?.trim() === "It was stopped.";
      return state.map((row) =>
        row.handedOver && row.status === "running"
          ? { ...row, status: noteStopped ? "stopped" : "done", endedAt: action.now }
          : row,
      );
    }
    case "app.start": {
      const existing = state.find((r) => r.id === action.id);
      return upsertRecord(state, {
        id: action.id,
        name: "app",
        args: action.args,
        status: "running",
        startedAt: existing?.startedAt ?? action.now,
        handedOver: false,
      });
    }
    case "app.end": {
      const cur = state.find((r) => r.id === action.id);
      return upsertRecord(state, {
        id: action.id,
        name: "app",
        ...(cur?.args !== undefined ? { args: cur.args } : {}),
        status: action.isError ? "error" : "done",
        startedAt: cur?.startedAt ?? action.now,
        endedAt: action.now,
        result: action.result,
        handedOver: false,
      });
    }
    case "task.stopped":
      return state.map((row) =>
        row.handedOver && row.status === "running"
          ? { ...row, status: "stopped", endedAt: action.now }
          : row,
      );
  }
}

export const ELAPSED_VISIBILITY_MS = 3_000;

export function formatActivityElapsed(
  startedAt: number,
  nowMs: number,
  t: TranslateFn,
): string | null {
  const elapsedMs = nowMs - startedAt;
  if (!Number.isFinite(elapsedMs) || elapsedMs < ELAPSED_VISIBILITY_MS) return null;
  const totalSec = Math.max(1, Math.floor(elapsedMs / 1000));
  if (totalSec < 60) {
    return t("voice.activity.elapsed.s", { seconds: totalSec });
  }
  return t("voice.activity.elapsed.m", {
    minutes: Math.floor(totalSec / 60),
    seconds: totalSec % 60,
  });
}
