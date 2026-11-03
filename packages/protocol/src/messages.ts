// Request (client -> server) and event (server -> client) catalogues.
// Wire frames are flat JSON: request = { id, type, ...params }, event = { type, ...body },
// response = { type: "response", id, ok: true, result } | { type: "response", id, ok: false, error }.
import { type Static, type TSchema, Type } from "typebox";
import { DbMutateRequest, DbMutateResult, DbQueryRequest } from "./db";
import {
  ApprovalDecision,
  AssistantItem,
  ProtocolError,
  Risk,
  SessionSummary,
  Settings,
  SettingsUpdate,
  SnapshotSummary,
  SyncState,
  TranscriptItem,
  UserItem,
} from "./model";

const SessionRef = Type.Object({ sessionId: Type.String() });
const Accepted = Type.Object({ accepted: Type.Boolean() });
const Empty = Type.Object({});

export const Requests = {
  /** Must be the first frame on a connection. */
  hello: {
    params: Type.Object({
      token: Type.String(),
      protocolVersion: Type.Integer(),
      client: Type.Optional(Type.String()),
    }),
    result: Type.Object({
      protocolVersion: Type.Integer(),
      serverVersion: Type.String(),
      farmId: Type.Union([Type.String(), Type.Null()]),
    }),
  },
  "sessions.list": {
    params: Empty,
    result: Type.Object({ sessions: Type.Array(SessionSummary) }),
  },
  "sessions.create": {
    params: Type.Object({ title: Type.Optional(Type.String()) }),
    result: Type.Object({ session: SessionSummary }),
  },
  /** Returns the transcript as UI-ready items, oldest first. */
  "sessions.open": {
    params: SessionRef,
    result: Type.Object({ session: SessionSummary, items: Type.Array(TranscriptItem) }),
  },
  /** Forks a session; with fromItemId the fork keeps history up to and including that user item. */
  "sessions.fork": {
    params: Type.Object({ sessionId: Type.String(), fromItemId: Type.Optional(Type.String()) }),
    result: Type.Object({ session: SessionSummary }),
  },
  "sessions.rename": {
    params: Type.Object({ sessionId: Type.String(), title: Type.String({ minLength: 1 }) }),
    result: Type.Object({ session: SessionSummary }),
  },
  "sessions.delete": { params: SessionRef, result: Type.Object({ deleted: Type.Boolean() }) },
  /** Starts a run. Resolves once accepted; output streams as events. Fails with busy while streaming. */
  "chat.prompt": {
    params: Type.Object({ sessionId: Type.String(), text: Type.String({ minLength: 1 }) }),
    result: Accepted,
  },
  /** Interrupts the running turn with a new instruction (Pi steer). */
  "chat.steer": {
    params: Type.Object({ sessionId: Type.String(), text: Type.String({ minLength: 1 }) }),
    result: Accepted,
  },
  /** Queues a message delivered after the current run finishes (Pi followUp). */
  "chat.followUp": {
    params: Type.Object({ sessionId: Type.String(), text: Type.String({ minLength: 1 }) }),
    result: Accepted,
  },
  "chat.abort": { params: SessionRef, result: Accepted },
  "approval.respond": {
    params: Type.Object({ approvalId: Type.String(), decision: ApprovalDecision }),
    result: Accepted,
  },
  "settings.get": { params: Empty, result: Settings },
  "settings.update": { params: SettingsUpdate, result: Settings },
  "db.query": { params: DbQueryRequest, result: Type.Unknown() },
  "db.mutate": { params: DbMutateRequest, result: DbMutateResult },
  "snapshots.list": {
    params: Type.Object({
      sessionId: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }),
    result: Type.Object({ snapshots: Type.Array(SnapshotSummary) }),
  },
  "snapshots.undo": {
    params: Type.Object({ snapshotId: Type.String() }),
    result: Type.Object({
      snapshot: SnapshotSummary,
      restored: Type.Array(Type.Object({ table: Type.String(), ids: Type.Array(Type.String()) })),
    }),
  },
} as const satisfies Record<string, { params: TSchema; result: TSchema }>;

export type RequestType = keyof typeof Requests;
export const REQUEST_TYPES = Object.keys(Requests) as RequestType[];
// db.query / db.mutate unions are built from mapped arrays, so their static types are spelled out in db.ts.
export type RequestParams<T extends RequestType> = T extends "db.query"
  ? DbQueryRequest
  : T extends "db.mutate"
    ? DbMutateRequest
    : Static<(typeof Requests)[T]["params"]>;
export type RequestResult<T extends RequestType> = Static<(typeof Requests)[T]["result"]>;
export type RequestFrame<T extends RequestType = RequestType> = {
  [K in T]: { id: string; type: K } & RequestParams<K>;
}[T];
export type ClientMessage = RequestFrame;

export const ResponseFrame = Type.Union([
  Type.Object({
    type: Type.Literal("response"),
    id: Type.String(),
    ok: Type.Literal(true),
    result: Type.Unknown(),
  }),
  Type.Object({
    type: Type.Literal("response"),
    id: Type.String(),
    ok: Type.Literal(false),
    error: ProtocolError,
  }),
]);
export type ResponseFrame = Static<typeof ResponseFrame>;

const Chat = { sessionId: Type.String() };

export const Events = {
  "session.updated": Type.Object({ ...Chat, session: SessionSummary }),
  /** A message begins. For user messages the server emits start + end with the final item. */
  "message.start": Type.Object({
    ...Chat,
    messageId: Type.String(),
    role: Type.Enum(["user", "assistant"]),
  }),
  /** Incremental text or thinking appended to the message. */
  "message.delta": Type.Object({
    ...Chat,
    messageId: Type.String(),
    text: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
  }),
  /** Authoritative final message; replaces any accumulated deltas. */
  "message.end": Type.Object({
    ...Chat,
    messageId: Type.String(),
    item: Type.Union([UserItem, AssistantItem]),
  }),
  "tool.start": Type.Object({
    ...Chat,
    toolCallId: Type.String(),
    name: Type.String(),
    label: Type.String(),
    args: Type.Unknown(),
  }),
  "tool.update": Type.Object({
    ...Chat,
    toolCallId: Type.String(),
    /** Latest partial result text (replaces the previous partial). */
    partial: Type.String(),
  }),
  "tool.end": Type.Object({
    ...Chat,
    toolCallId: Type.String(),
    result: Type.String(),
    details: Type.Unknown(),
    isError: Type.Boolean(),
    durationMs: Type.Number(),
  }),
  "approval.request": Type.Object({
    ...Chat,
    approvalId: Type.String(),
    toolCallId: Type.Optional(Type.String()),
    toolName: Type.String(),
    title: Type.String(),
    /** What will happen, in words a farmer understands. */
    plainLanguage: Type.String(),
    /** Exact shell command or SQL, when there is one. */
    command: Type.Optional(Type.String()),
    risk: Risk,
  }),
  "approval.resolved": Type.Object({
    ...Chat,
    approvalId: Type.String(),
    decision: ApprovalDecision,
    by: Type.Enum(["user", "policy", "abort", "timeout"]),
  }),
  /** The agent finished and will not continue on its own. */
  "agent.settled": Type.Object({
    ...Chat,
    reason: Type.Enum(["completed", "aborted", "error"]),
    errorMessage: Type.Optional(Type.String()),
  }),
  "db.changed": Type.Object({ table: Type.String(), ids: Type.Array(Type.String()) }),
  "sync.status": Type.Object({
    state: SyncState,
    pendingOutbox: Type.Integer(),
    lastSyncedAt: Type.Union([Type.String(), Type.Null()]),
    error: Type.Optional(Type.String()),
  }),
  error: Type.Object({
    sessionId: Type.Optional(Type.String()),
    code: Type.String(),
    message: Type.String(),
  }),
} as const satisfies Record<string, TSchema>;

export type EventType = keyof typeof Events;
export const EVENT_TYPES = Object.keys(Events) as EventType[];
export type EventBody<E extends EventType> = Static<(typeof Events)[E]>;
export type EventFrame<E extends EventType = EventType> = {
  [K in E]: { type: K } & EventBody<K>;
}[E];
export type ServerEvent = EventFrame;
export type ServerMessage = ResponseFrame | ServerEvent;
