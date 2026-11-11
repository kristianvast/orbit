import type { EventFrame, ServerEvent, SessionSummary, TranscriptItem } from "@orbit/protocol";
import { classifyPlanError } from "./PlanErrorCard";

export interface ChatState {
  sessionId: string | null;
  session: SessionSummary | null;
  items: TranscriptItem[];
  streaming: boolean;
  lastError: string | null;
  lastErrorCode: string | null;
  settledReason: "completed" | "aborted" | "error" | null;
  /** Messages sent while a run was going; they leave the list when Orion delivers them. */
  queued: QueuedMessage[];
  runStartedAt: string | null;
  /** True from sending a prompt until the server announces that prompt's user message. */
  awaitingPromptStart: boolean;
}

export interface QueuedMessage {
  id: string;
  text: string;
  mode: "steer" | "followUp";
}

export type ChatAction =
  | {
      type: "session.opened";
      session: SessionSummary;
      items: TranscriptItem[];
    }
  | {
      type: "session.cleared";
    }
  | {
      type: "optimistic.user_message";
      text: string;
      id?: string;
      ts?: string;
    }
  | {
      type: "optimistic.rollback";
      id: string;
    }
  | {
      type: "server.event";
      event: ServerEvent;
    }
  | {
      type: "queue.add";
      message: QueuedMessage;
    }
  | {
      type: "queue.remove";
      id: string;
    }
  | {
      type: "error.set";
      code?: string;
      message: string;
    }
  | {
      type: "error.clear";
    };

export function createInitialChatState(sessionId: string | null = null): ChatState {
  return {
    sessionId,
    session: null,
    items: [],
    streaming: false,
    lastError: null,
    lastErrorCode: null,
    settledReason: null,
    queued: [],
    runStartedAt: null,
    awaitingPromptStart: false,
  };
}

function lastUserTs(items: readonly TranscriptItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    if (it?.kind === "user") return it.ts;
  }
  return null;
}

function applyMessageStart(state: ChatState, ev: EventFrame<"message.start">): ChatState {
  if (state.sessionId && ev.sessionId !== state.sessionId) return state;

  if (ev.role === "user") {
    const now = new Date().toISOString();
    const base: ChatState = {
      ...state,
      streaming: true,
      settledReason: null,
      runStartedAt: state.runStartedAt ?? now,
    };
    if (state.awaitingPromptStart) return { ...base, awaitingPromptStart: false };
    if (state.items.some((it) => it.id === ev.messageId)) return base;
    // A queued message is being delivered mid-run. Its message.end only arrives after the
    // replies, so hold its place now; Pi hands over steers before follow-ups.
    const delivered = state.queued.find((q) => q.mode === "steer") ?? state.queued[0];
    const placeholder: TranscriptItem = {
      kind: "user",
      id: ev.messageId,
      ts: now,
      text: delivered?.text ?? "",
    };
    return {
      ...base,
      items: [...state.items, placeholder],
      queued: delivered ? state.queued.filter((q) => q !== delivered) : state.queued,
    };
  }

  const exists = state.items.some((it) => it.id === ev.messageId);
  if (exists) {
    return {
      ...state,
      streaming: true,
      settledReason: null,
    };
  }

  const nextAssistant: TranscriptItem = {
    kind: "assistant",
    id: ev.messageId,
    ts: new Date().toISOString(),
    text: "",
  };

  return {
    ...state,
    streaming: true,
    settledReason: null,
    items: [...state.items, nextAssistant],
  };
}

function applyMessageDelta(state: ChatState, ev: EventFrame<"message.delta">): ChatState {
  if (state.sessionId && ev.sessionId !== state.sessionId) return state;

  const idx = state.items.findIndex((it) => it.id === ev.messageId);
  if (idx < 0) {
    const created: TranscriptItem = {
      kind: "assistant",
      id: ev.messageId,
      ts: new Date().toISOString(),
      text: ev.text ?? "",
      ...(ev.thinking ? { thinking: ev.thinking } : {}),
    };
    return {
      ...state,
      streaming: true,
      items: [...state.items, created],
    };
  }

  const current = state.items[idx];
  if (current?.kind !== "assistant") return state;

  const updated: TranscriptItem = {
    ...current,
    text: current.text + (ev.text ?? ""),
    ...(ev.thinking ? { thinking: (current.thinking ?? "") + ev.thinking } : {}),
  };

  const nextItems = [...state.items];
  nextItems[idx] = updated;
  return {
    ...state,
    streaming: true,
    items: nextItems,
  };
}

function dequeueDelivered(state: ChatState, text: string): ChatState {
  const idx = state.queued.findIndex((q) => q.text.trim() === text.trim());
  if (idx < 0) return state;
  return { ...state, queued: state.queued.filter((_, i) => i !== idx) };
}

function applyMessageEnd(prev: ChatState, ev: EventFrame<"message.end">): ChatState {
  if (prev.sessionId && ev.sessionId !== prev.sessionId) return prev;

  const baseState = ev.item.kind === "user" ? dequeueDelivered(prev, ev.item.text) : prev;
  const isVoiceTurn =
    (ev.item.kind === "user" || ev.item.kind === "assistant") && ev.item.voice === true;
  const state: ChatState = isVoiceTurn
    ? {
        ...baseState,
        streaming: Boolean(baseState.session?.streaming),
        runStartedAt: baseState.session?.streaming ? baseState.runStartedAt : null,
      }
    : baseState;
  const nextItems = [...state.items];

  if (ev.item.kind === "user") {
    const exactIdx = nextItems.findIndex((it) => it.id === ev.messageId || it.id === ev.item.id);
    if (exactIdx >= 0) {
      nextItems[exactIdx] = ev.item;
      return { ...state, items: nextItems };
    }

    const optimisticIdx = nextItems.findIndex(
      (it) =>
        it.kind === "user" &&
        it.id.startsWith("optimistic-") &&
        it.text.trim() === ev.item.text.trim(),
    );
    if (optimisticIdx >= 0) {
      nextItems[optimisticIdx] = ev.item;
      return { ...state, items: nextItems };
    }

    nextItems.push(ev.item);
    return { ...state, items: nextItems };
  }

  const idx = nextItems.findIndex((it) => it.id === ev.messageId || it.id === ev.item.id);
  if (idx >= 0) {
    if (!ev.item.text && !ev.item.thinking && !ev.item.errorMessage) {
      nextItems.splice(idx, 1);
    } else {
      nextItems[idx] = ev.item;
    }
    return { ...state, items: nextItems };
  }

  if (ev.item.text || ev.item.thinking || ev.item.errorMessage) {
    nextItems.push(ev.item);
  }
  return { ...state, items: nextItems };
}

function applyToolStart(state: ChatState, ev: EventFrame<"tool.start">): ChatState {
  if (state.sessionId && ev.sessionId !== state.sessionId) return state;

  const existingIdx = state.items.findIndex(
    (it) => it.kind === "tool" && it.toolCallId === ev.toolCallId,
  );

  const toolItem: TranscriptItem = {
    kind: "tool",
    id: ev.toolCallId,
    ts: new Date().toISOString(),
    toolCallId: ev.toolCallId,
    name: ev.name,
    label: ev.label,
    args: ev.args,
    status: "running",
  };

  if (existingIdx >= 0) {
    const nextItems = [...state.items];
    nextItems[existingIdx] = toolItem;
    return { ...state, streaming: true, items: nextItems };
  }

  return {
    ...state,
    streaming: true,
    items: [...state.items, toolItem],
  };
}

function applyToolUpdate(state: ChatState, ev: EventFrame<"tool.update">): ChatState {
  if (state.sessionId && ev.sessionId !== state.sessionId) return state;

  const idx = state.items.findIndex((it) => it.kind === "tool" && it.toolCallId === ev.toolCallId);
  if (idx < 0) return state;

  const current = state.items[idx];
  if (current?.kind !== "tool") return state;

  const nextItems = [...state.items];
  nextItems[idx] = {
    ...current,
    result: ev.partial,
  };
  return {
    ...state,
    items: nextItems,
  };
}

function applyToolEnd(state: ChatState, ev: EventFrame<"tool.end">): ChatState {
  if (state.sessionId && ev.sessionId !== state.sessionId) return state;

  const status = ev.isError ? "error" : "done";

  const idx = state.items.findIndex((it) => it.kind === "tool" && it.toolCallId === ev.toolCallId);

  if (idx < 0) {
    const fallbackTool: TranscriptItem = {
      kind: "tool",
      id: ev.toolCallId,
      ts: new Date().toISOString(),
      toolCallId: ev.toolCallId,
      name: "tool",
      label: "Tool call",
      args: {},
      status,
      result: ev.result,
      details: ev.details,
      isError: ev.isError,
      durationMs: ev.durationMs,
    };
    return {
      ...state,
      items: [...state.items, fallbackTool],
    };
  }

  const current = state.items[idx];
  if (current?.kind !== "tool") return state;

  const nextItems = [...state.items];
  nextItems[idx] = {
    ...current,
    status,
    result: ev.result,
    details: ev.details,
    isError: ev.isError,
    durationMs: ev.durationMs,
  };
  return {
    ...state,
    items: nextItems,
  };
}

function applyAgentSettled(state: ChatState, ev: EventFrame<"agent.settled">): ChatState {
  if (state.sessionId && ev.sessionId !== state.sessionId) return state;

  const nextItems = state.items.map((item) => {
    if (item.kind === "tool" && item.status === "running") {
      return {
        ...item,
        status: ev.reason === "aborted" ? ("aborted" as const) : item.status,
      };
    }
    return item;
  });

  const planCode = ev.errorMessage ? classifyPlanError(null, ev.errorMessage) : null;

  return {
    ...state,
    streaming: false,
    settledReason: ev.reason,
    lastError: ev.errorMessage ?? state.lastError,
    lastErrorCode: planCode ?? state.lastErrorCode,
    items: nextItems,
    queued: [],
    runStartedAt: null,
    awaitingPromptStart: false,
  };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "session.opened": {
      return {
        sessionId: action.session.id,
        session: action.session,
        items: action.items,
        streaming: action.session.streaming,
        lastError: null,
        lastErrorCode: null,
        settledReason: null,
        queued: [],
        runStartedAt: action.session.streaming ? lastUserTs(action.items) : null,
        awaitingPromptStart: false,
      };
    }
    case "session.cleared":
      return createInitialChatState(null);
    case "optimistic.user_message": {
      const userMsg: TranscriptItem = {
        kind: "user",
        id: action.id ?? `optimistic-${Date.now()}`,
        ts: action.ts ?? new Date().toISOString(),
        text: action.text,
      };
      return {
        ...state,
        streaming: true,
        settledReason: null,
        lastError: null,
        lastErrorCode: null,
        items: [...state.items, userMsg],
        runStartedAt: state.runStartedAt ?? userMsg.ts,
        awaitingPromptStart: true,
      };
    }
    case "optimistic.rollback":
      return {
        ...state,
        items: state.items.filter((it) => it.id !== action.id),
        streaming: false,
        runStartedAt: null,
        awaitingPromptStart: false,
      };
    case "queue.add":
      return { ...state, queued: [...state.queued, action.message] };
    case "queue.remove":
      return { ...state, queued: state.queued.filter((q) => q.id !== action.id) };
    case "error.set": {
      const planCode = classifyPlanError(action.code, action.message);
      return {
        ...state,
        streaming: false,
        awaitingPromptStart: false,
        lastError: action.message,
        lastErrorCode: planCode ?? action.code ?? null,
      };
    }
    case "error.clear":
      return { ...state, lastError: null, lastErrorCode: null };
    case "server.event": {
      const ev = action.event;
      switch (ev.type) {
        case "session.updated":
          if (state.sessionId !== ev.sessionId) return state;
          return {
            ...state,
            session: ev.session,
            streaming: ev.session.streaming,
            runStartedAt: ev.session.streaming
              ? (state.runStartedAt ?? new Date().toISOString())
              : state.runStartedAt,
          };
        case "message.start":
          return applyMessageStart(state, ev);
        case "message.delta":
          return applyMessageDelta(state, ev);
        case "message.end":
          return applyMessageEnd(state, ev);
        case "tool.start":
          return applyToolStart(state, ev);
        case "tool.update":
          return applyToolUpdate(state, ev);
        case "tool.end":
          return applyToolEnd(state, ev);
        case "agent.settled":
          return applyAgentSettled(state, ev);
        case "error": {
          if (ev.sessionId && state.sessionId && ev.sessionId !== state.sessionId) {
            return state;
          }
          const planCode = classifyPlanError(ev.code, ev.message);
          return {
            ...state,
            streaming: false,
            awaitingPromptStart: false,
            lastError: ev.message,
            lastErrorCode: planCode ?? ev.code,
          };
        }
        default:
          return state;
      }
    }
  }
}
