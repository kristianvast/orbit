// Request (client -> server) and event (server -> client) catalogues.
// Wire frames are flat JSON: request = { id, type, ...params }, event = { type, ...body },
// response = { type: "response", id, ok: true, result } | { type: "response", id, ok: false, error }.
import { type Static, type TSchema, Type } from "typebox";
import { AccountEvents, AccountRequests } from "./account";
import { BillingRequests } from "./billing";
import { DbMutateRequest, DbMutateResult, DbQueryRequest } from "./db";
import { FeedbackRequests } from "./feedback";
import {
  AccessTool,
  AssistantItem,
  AuthMethod,
  AuthNotice,
  AuthPromptInfo,
  AuthProviderInfo,
  CustomPage,
  ErrorCode,
  LocalUiStatus,
  ProtocolError,
  SessionSummary,
  Settings,
  SettingsUpdate,
  SnapshotSummary,
  SyncState,
  TranscriptItem,
  UserItem,
} from "./model";
import { VoiceEvents, VoiceRequests } from "./voice";

/** Built-in screens that start switched off; Home, Chat, Settings and custom pages are not modules. */
export const MODULE_IDS = ["herd", "devices", "cameras"] as const;
export const ModuleId = Type.Union([
  Type.Literal("herd"),
  Type.Literal("devices"),
  Type.Literal("cameras"),
]);
export type ModuleId = (typeof MODULE_IDS)[number];
export const ModuleEnabledBy = Type.Union([
  Type.Literal("orion"),
  Type.Literal("user"),
  Type.Literal("auto"),
  Type.Null(),
]);
export type ModuleEnabledBy = Static<typeof ModuleEnabledBy>;
export const OrbitModule = Type.Object({
  id: ModuleId,
  enabled: Type.Boolean(),
  /** ISO time it was last switched on; null while off. */
  enabledAt: Type.Union([Type.String(), Type.Null()]),
  enabledBy: ModuleEnabledBy,
});
export type OrbitModule = Static<typeof OrbitModule>;
/** Always all of MODULE_IDS, in that order. */
export const ModulesState = Type.Object({ modules: Type.Array(OrbitModule) });
export type ModulesState = Static<typeof ModulesState>;
// Not `id`: request frames are flat and `id` is the request id.
const ModuleRef = Type.Object({ moduleId: ModuleId });

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
  /** Pages Orion built in the farm workspace. */
  "pages.list": { params: Empty, result: Type.Object({ pages: Type.Array(CustomPage) }) },
  /** Whether a checked local build of the UI exists (see LocalUiState). */
  "localUi.status": { params: Empty, result: LocalUiStatus },
  /** The shipped UI is about to hand off to the local build. */
  "localUi.launched": { params: Empty, result: LocalUiStatus },
  /** The local build mounted its shell; clears the broken check for this launch. */
  "localUi.booted": { params: Empty, result: LocalUiStatus },
  /** Stop using the local build; the shipped UI is used from the next start. */
  "localUi.disable": { params: Empty, result: LocalUiStatus },
  /** Which built-in modules (herd, devices, cameras) are switched on. */
  "modules.list": { params: Empty, result: ModulesState },
  /** The farmer switches a module on (enabledBy "user"). */
  "modules.enable": { params: ModuleRef, result: ModulesState },
  /** The farmer switches a module off. */
  "modules.disable": { params: ModuleRef, result: ModulesState },
  /** Answers an access.request; allow is remembered for that tool in Settings.toolAccess. */
  "access.respond": {
    params: Type.Object({ requestId: Type.String(), allow: Type.Boolean() }),
    result: Accepted,
  },
  "settings.get": { params: Empty, result: Settings },
  "settings.update": { params: SettingsUpdate, result: Settings },
  /** Model providers Orion can sign in to, with their current status (Pi's /login list). */
  "auth.providers": {
    params: Empty,
    result: Type.Object({ providers: Type.Array(AuthProviderInfo) }),
  },
  /** Starts a sign-in. Steps stream as auth.notice / auth.prompt; auth.finished ends it. */
  "auth.login": {
    params: Type.Object({ providerId: Type.String(), method: AuthMethod }),
    result: Type.Object({ loginId: Type.String() }),
  },
  /** Answers an auth.prompt (a select answers with the option id). */
  "auth.respond": {
    params: Type.Object({ loginId: Type.String(), promptId: Type.String(), value: Type.String() }),
    result: Accepted,
  },
  "auth.cancel": { params: Type.Object({ loginId: Type.String() }), result: Accepted },
  /** Removes the credential saved by sign-in. Environment variables are left alone. */
  "auth.logout": {
    params: Type.Object({ providerId: Type.String() }),
    result: Type.Object({ providers: Type.Array(AuthProviderInfo) }),
  },
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
  ...AccountRequests,
  ...BillingRequests,
  ...FeedbackRequests,
  ...VoiceRequests,
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
  /** The agent finished and will not continue on its own. */
  "agent.settled": Type.Object({
    ...Chat,
    reason: Type.Enum(["completed", "aborted", "error"]),
    errorMessage: Type.Optional(Type.String()),
  }),
  /**
   * Orion wants to use one of these tools for the first time and waits for the farmer's yes for
   * that tool (access.respond). Sent again to a client that connects while it is still open.
   */
  "access.request": Type.Object({
    ...Chat,
    requestId: Type.String(),
    tool: AccessTool,
  }),
  /** The access question was answered (or dropped because the run stopped); close it everywhere. */
  "access.resolved": Type.Object({ requestId: Type.String(), allow: Type.Boolean() }),
  "db.changed": Type.Object({ table: Type.String(), ids: Type.Array(Type.String()) }),
  /** A new local UI build passed its checks; a running local UI reloads. */
  "localUi.updated": LocalUiStatus,
  /** Module state changed (by Orion, the farmer, or data appearing). */
  "modules.updated": ModulesState,
  "auth.notice": Type.Object({ loginId: Type.String(), notice: AuthNotice }),
  "auth.prompt": Type.Object({
    loginId: Type.String(),
    promptId: Type.String(),
    prompt: AuthPromptInfo,
  }),
  /** A sign-in ended. cancelled is true when the user stopped it. */
  "auth.finished": Type.Object({
    loginId: Type.String(),
    providerId: Type.String(),
    ok: Type.Boolean(),
    cancelled: Type.Boolean(),
    error: Type.Optional(Type.String()),
  }),
  "sync.status": Type.Object({
    state: SyncState,
    pendingOutbox: Type.Integer(),
    lastSyncedAt: Type.Union([Type.String(), Type.Null()]),
    error: Type.Optional(Type.String()),
  }),
  error: Type.Object({
    sessionId: Type.Optional(Type.String()),
    code: ErrorCode,
    message: Type.String(),
  }),
  ...AccountEvents,
  ...VoiceEvents,
} as const satisfies Record<string, TSchema>;

export type EventType = keyof typeof Events;
export const EVENT_TYPES = Object.keys(Events) as EventType[];
export type EventBody<E extends EventType> = Static<(typeof Events)[E]>;
export type EventFrame<E extends EventType = EventType> = {
  [K in E]: { type: K } & EventBody<K>;
}[E];
export type ServerEvent = EventFrame;
export type ServerMessage = ResponseFrame | ServerEvent;
