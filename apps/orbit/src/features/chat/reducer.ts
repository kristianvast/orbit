import type {
  ApprovalDecision,
  EventFrame,
  Risk,
  ServerEvent,
  SessionSummary,
  TranscriptItem,
} from "@orbit/protocol";

export interface PendingApprovalItem {
  approvalId: string;
  sessionId: string;
  toolCallId?: string;
  toolName: string;
  title: string;
  plainLanguage: string;
  command?: string;
  risk: Risk;
  status: "pending" | "resolved";
  decision?: ApprovalDecision;
  resolvedBy?: "user" | "policy" | "abort" | "timeout";
}

export interface ChatState {
  sessionId: string | null;
  session: SessionSummary | null;
  items: TranscriptItem[];
  streaming: boolean;
  approvals: PendingApprovalItem[];
  lastError: string | null;
  settledReason: "completed" | "aborted" | "error" | null;
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
      type: "server.event";
      event: ServerEvent;
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
    approvals: [],
    lastError: null,
    settledReason: null,
  };
}

function applyMessageStart(state: ChatState, ev: EventFrame<"message.start">): ChatState {
  if (state.sessionId && ev.sessionId !== state.sessionId) return state;

  if (ev.role === "user") {
    return {
      ...state,
      streaming: true,
      settledReason: null,
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

function applyMessageEnd(state: ChatState, ev: EventFrame<"message.end">): ChatState {
  if (state.sessionId && ev.sessionId !== state.sessionId) return state;

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

  const status = !ev.isError ? "done" : ev.result.startsWith("Not allowed:") ? "denied" : "error";

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

function applyApprovalRequest(state: ChatState, ev: EventFrame<"approval.request">): ChatState {
  const entry: PendingApprovalItem = {
    approvalId: ev.approvalId,
    sessionId: ev.sessionId,
    toolCallId: ev.toolCallId,
    toolName: ev.toolName,
    title: ev.title,
    plainLanguage: ev.plainLanguage,
    command: ev.command,
    risk: ev.risk,
    status: "pending",
  };

  const existingIdx = state.approvals.findIndex((a) => a.approvalId === ev.approvalId);
  if (existingIdx >= 0) {
    const next = [...state.approvals];
    next[existingIdx] = entry;
    return { ...state, approvals: next };
  }

  return {
    ...state,
    approvals: [...state.approvals, entry],
  };
}

function applyApprovalResolved(state: ChatState, ev: EventFrame<"approval.resolved">): ChatState {
  const idx = state.approvals.findIndex((a) => a.approvalId === ev.approvalId);
  if (idx < 0) return state;

  const current = state.approvals[idx];
  if (!current) return state;

  const next = [...state.approvals];
  next[idx] = {
    ...current,
    status: "resolved",
    decision: ev.decision,
    resolvedBy: ev.by,
  };
  return {
    ...state,
    approvals: next,
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

  const nextApprovals = state.approvals.map((a) => {
    if (a.sessionId === ev.sessionId && a.status === "pending") {
      return {
        ...a,
        status: "resolved" as const,
        decision: "deny" as const,
        resolvedBy: "abort" as const,
      };
    }
    return a;
  });

  return {
    ...state,
    streaming: false,
    settledReason: ev.reason,
    lastError: ev.errorMessage ?? state.lastError,
    items: nextItems,
    approvals: nextApprovals,
  };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "session.opened": {
      const keptApprovals = state.approvals.filter(
        (a) => a.sessionId === action.session.id || a.status === "pending",
      );
      return {
        sessionId: action.session.id,
        session: action.session,
        items: action.items,
        streaming: action.session.streaming,
        approvals: keptApprovals,
        lastError: null,
        settledReason: null,
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
        items: [...state.items, userMsg],
      };
    }
    case "error.clear":
      return { ...state, lastError: null };
    case "server.event": {
      const ev = action.event;
      switch (ev.type) {
        case "session.updated":
          if (state.sessionId !== ev.sessionId) return state;
          return {
            ...state,
            session: ev.session,
            streaming: ev.session.streaming,
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
        case "approval.request":
          return applyApprovalRequest(state, ev);
        case "approval.resolved":
          return applyApprovalResolved(state, ev);
        case "agent.settled":
          return applyAgentSettled(state, ev);
        case "error":
          if (ev.sessionId && state.sessionId && ev.sessionId !== state.sessionId) {
            return state;
          }
          return {
            ...state,
            lastError: ev.message,
          };
        default:
          return state;
      }
    }
  }
}
