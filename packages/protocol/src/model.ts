// Shared value types carried by requests, responses and events.
import {
  ANIMAL_SEX,
  ANIMAL_STATUS,
  CAMERA_STATUS,
  CONNECTOR_KINDS,
  CONNECTOR_VENDORS,
  DEVICE_KINDS,
  DEVICE_STATUS,
  OBSERVATION_KINDS,
  SPECIES,
} from "@orbit/schema/enums";
import { type Static, Type } from "typebox";

export const PROTOCOL_VERSION = 1;
/** Default dev-server address used by the UI in browser dev mode. */
export const DEV_SERVER_URL = "ws://127.0.0.1:7717/ws";
export const DEV_TOKEN = "dev";
/** Line printed on stdout by the Orion sidecar once listening: ORION_READY {"port":N} */
export const READY_LINE_PREFIX = "ORION_READY ";
/** WebSocket close codes used by the server. */
export const CloseCode = {
  unauthorized: 4401,
  protocolError: 4400,
  serverShutdown: 4001,
} as const;

export const Json = Type.Record(Type.String(), Type.Unknown());

export const ErrorCode = Type.Enum([
  "bad_request",
  "unauthorized",
  "not_found",
  "conflict",
  "rule_violation",
  "busy",
  "not_ready",
  "internal",
  "timeout",
  "disconnected",
  "forbidden",
  "plan_required",
  "budget_exceeded",
]);
export type ErrorCode = Static<typeof ErrorCode>;

export const ProtocolError = Type.Object({
  code: ErrorCode,
  message: Type.String(),
  details: Type.Optional(Type.Unknown()),
});
export type ProtocolError = Static<typeof ProtocolError>;

// ------------------------------------------------------------------ sessions & transcript

export const SessionSummary = Type.Object({
  id: Type.String(),
  title: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  messageCount: Type.Integer(),
  model: Type.Union([Type.String(), Type.Null()]),
  /** True while the agent is running a turn in this session. */
  streaming: Type.Boolean(),
  parentSessionId: Type.Union([Type.String(), Type.Null()]),
});
export type SessionSummary = Static<typeof SessionSummary>;

export const ToolStatus = Type.Enum(["running", "done", "error", "aborted"]);
export type ToolStatus = Static<typeof ToolStatus>;

export const UserItem = Type.Object({
  kind: Type.Literal("user"),
  id: Type.String(),
  ts: Type.String(),
  text: Type.String(),
  /** True when the farmer said this in a voice call. */
  voice: Type.Optional(Type.Boolean()),
});
export const AssistantItem = Type.Object({
  kind: Type.Literal("assistant"),
  id: Type.String(),
  ts: Type.String(),
  text: Type.String(),
  thinking: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  stopReason: Type.Optional(Type.String()),
  errorMessage: Type.Optional(Type.String()),
  /** True when Orion said this in a voice call. */
  voice: Type.Optional(Type.Boolean()),
});
export const ToolItem = Type.Object({
  kind: Type.Literal("tool"),
  /** Equal to toolCallId. */
  id: Type.String(),
  ts: Type.String(),
  toolCallId: Type.String(),
  name: Type.String(),
  label: Type.String(),
  args: Type.Unknown(),
  status: ToolStatus,
  /** Text content of the tool result. */
  result: Type.Optional(Type.String()),
  details: Type.Optional(Type.Unknown()),
  isError: Type.Optional(Type.Boolean()),
  durationMs: Type.Optional(Type.Number()),
});
/** Compaction notices, aborted-run markers, etc. */
export const SystemItem = Type.Object({
  kind: Type.Literal("system"),
  id: Type.String(),
  ts: Type.String(),
  text: Type.String(),
});
export const TranscriptItem = Type.Union([UserItem, AssistantItem, ToolItem, SystemItem]);
export type UserItem = Static<typeof UserItem>;
export type AssistantItem = Static<typeof AssistantItem>;
export type ToolItem = Static<typeof ToolItem>;
export type SystemItem = Static<typeof SystemItem>;
export type TranscriptItem = Static<typeof TranscriptItem>;

// ------------------------------------------------------------------ settings

export const ThinkingLevel = Type.Enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
export type ThinkingLevel = Static<typeof ThinkingLevel>;

export const Settings = Type.Object({
  provider: Type.Union([Type.String(), Type.Null()]),
  model: Type.Union([Type.String(), Type.Null()]),
  thinkingLevel: ThinkingLevel,
  /** Share anonymised footage and outcomes to improve the models. On by default; opt out in settings. */
  shareAnonymousData: Type.Boolean(),
  species: Type.Optional(Type.Enum([...SPECIES])),
  /** Per provider: whether a key is stored (in the OS keychain) and a masked hint. Never the key. */
  apiKeys: Type.Record(
    Type.String(),
    Type.Object({ configured: Type.Boolean(), hint: Type.Optional(Type.String()) }),
  ),
  availableModels: Type.Array(
    Type.Object({ provider: Type.String(), id: Type.String(), name: Type.String() }),
  ),
});
export type Settings = Static<typeof Settings>;

export const SettingsUpdate = Type.Object({
  provider: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  thinkingLevel: Type.Optional(ThinkingLevel),
  shareAnonymousData: Type.Optional(Type.Boolean()),
  species: Type.Optional(Type.Enum([...SPECIES])),
  /** key null removes the stored key. */
  apiKey: Type.Optional(
    Type.Object({ provider: Type.String(), key: Type.Union([Type.String(), Type.Null()]) }),
  ),
});
export type SettingsUpdate = Static<typeof SettingsUpdate>;

// ------------------------------------------------------------------ custom pages

/** A page Orion built in the farm workspace (pages/<id>/index.html), shown in the app nav. */
export const CustomPage = Type.Object({
  id: Type.String(),
  title: Type.String(),
  description: Type.Optional(Type.String()),
  /** Server path of the entry file, relative to Orion's HTTP origin. Carries the session token. */
  path: Type.String(),
  /** Present when page.json names a card file: a small summary Home shows, linking to the page. */
  card: Type.Optional(Type.Object({ path: Type.String() })),
});
export type CustomPage = Static<typeof CustomPage>;

// ------------------------------------------------------------------ local UI build

/**
 * none: no usable local build (never built, turned off, or the last build failed).
 * ready: a checked build exists; the shipped UI hands off to it at startup.
 * broken: the last hand-off never reported booted, so the shipped UI stays (safe mode).
 */
export const LocalUiState = Type.Enum(["none", "ready", "broken"]);
export type LocalUiState = Static<typeof LocalUiState>;

export const LocalUiStatus = Type.Object({
  state: LocalUiState,
  /** Server path of the local build's entry, relative to Orion's HTTP origin. Carries the token. */
  path: Type.Union([Type.String(), Type.Null()]),
  builtAt: Type.Union([Type.String(), Type.Null()]),
  /** git HEAD of the checkout the build came from, when known. */
  commit: Type.Union([Type.String(), Type.Null()]),
  /** Orbit release the build's source sits on (e.g. "0.1.6"); absent from older Orions. */
  baseVersion: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type LocalUiStatus = Static<typeof LocalUiStatus>;

// ------------------------------------------------------------------ model provider sign-in

/** oauth: sign in with an account (often a subscription). api_key: paste a key. */
export const AuthMethod = Type.Enum(["oauth", "api_key"]);
export type AuthMethod = Static<typeof AuthMethod>;

/** A model provider Orion can sign in to, mirroring Pi's /login list. Never carries secrets. */
export const AuthProviderInfo = Type.Object({
  id: Type.String(),
  name: Type.String(),
  oauth: Type.Union([
    Type.Object({
      name: Type.String(),
      subscription: Type.Boolean(),
      label: Type.Optional(Type.String()),
    }),
    Type.Null(),
  ]),
  apiKey: Type.Union([Type.Object({ name: Type.String() }), Type.Null()]),
  status: Type.Object({
    configured: Type.Boolean(),
    /** How the provider is authenticated when configured. */
    method: Type.Union([AuthMethod, Type.Null()]),
    /** stored: saved by sign-in here; environment: an env var or ambient config on this PC. */
    source: Type.Union([Type.String(), Type.Null()]),
  }),
  modelCount: Type.Integer(),
});
export type AuthProviderInfo = Static<typeof AuthProviderInfo>;

/** A question a sign-in flow asks; answered with auth.respond. */
export const AuthPromptInfo = Type.Object({
  type: Type.Enum(["text", "secret", "select", "manual_code"]),
  message: Type.String(),
  placeholder: Type.Optional(Type.String()),
  options: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        label: Type.String(),
        description: Type.Optional(Type.String()),
      }),
    ),
  ),
});
export type AuthPromptInfo = Static<typeof AuthPromptInfo>;

/** Progress shown while a sign-in flow runs. */
export const AuthNotice = Type.Union([
  Type.Object({
    type: Type.Literal("info"),
    message: Type.String(),
    links: Type.Optional(
      Type.Array(Type.Object({ url: Type.String(), label: Type.Optional(Type.String()) })),
    ),
  }),
  Type.Object({
    type: Type.Literal("auth_url"),
    url: Type.String(),
    instructions: Type.Optional(Type.String()),
    /** True when Orion already opened the page in the system browser. */
    opened: Type.Boolean(),
  }),
  Type.Object({
    type: Type.Literal("device_code"),
    userCode: Type.String(),
    verificationUri: Type.String(),
    expiresInSeconds: Type.Optional(Type.Number()),
  }),
  Type.Object({ type: Type.Literal("progress"), message: Type.String() }),
]);
export type AuthNotice = Static<typeof AuthNotice>;

// ------------------------------------------------------------------ snapshots & sync

export const SnapshotSummary = Type.Object({
  id: Type.String(),
  createdAt: Type.String(),
  description: Type.String(),
  sessionId: Type.Union([Type.String(), Type.Null()]),
  toolCallId: Type.Union([Type.String(), Type.Null()]),
  tables: Type.Array(Type.String()),
  rowCount: Type.Integer(),
  undoneAt: Type.Union([Type.String(), Type.Null()]),
});
export type SnapshotSummary = Static<typeof SnapshotSummary>;

export const SyncState = Type.Enum([
  "disabled",
  "offline",
  "connecting",
  "syncing",
  "up_to_date",
  "error",
]);
export type SyncState = Static<typeof SyncState>;

// ------------------------------------------------------------------ db write inputs

const OptStr = Type.Optional(Type.Union([Type.String(), Type.Null()]));

export const AnimalInput = Type.Object({
  /** Omit to create. */
  id: Type.Optional(Type.String()),
  species: Type.Enum([...SPECIES]),
  name: OptStr,
  earTagNumber: OptStr,
  nationalId: OptStr,
  breed: OptStr,
  sex: Type.Optional(Type.Enum([...ANIMAL_SEX])),
  birthDate: OptStr,
  groupName: OptStr,
  status: Type.Optional(Type.Enum([...ANIMAL_STATUS])),
  notes: OptStr,
});
export type AnimalInput = Static<typeof AnimalInput>;

export const DeviceInput = Type.Object({
  id: Type.Optional(Type.String()),
  kind: Type.Enum([...DEVICE_KINDS]),
  vendor: OptStr,
  model: OptStr,
  serial: OptStr,
  connection: Type.Optional(Type.Union([Json, Type.Null()])),
  status: Type.Optional(Type.Enum([...DEVICE_STATUS])),
  batteryPct: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});
export type DeviceInput = Static<typeof DeviceInput>;

export const ConnectorInput = Type.Object({
  id: Type.Optional(Type.String()),
  vendor: Type.Enum([...CONNECTOR_VENDORS]),
  kind: Type.Enum([...CONNECTOR_KINDS]),
  name: OptStr,
  /** Non-secret config only. */
  config: Type.Optional(Json),
  enabled: Type.Optional(Type.Boolean()),
  /** Optional secret; the server stores it in the OS keychain and keeps only a reference. */
  secret: Type.Optional(Type.String()),
});
export type ConnectorInput = Static<typeof ConnectorInput>;

export const CameraInput = Type.Object({
  id: Type.Optional(Type.String()),
  name: Type.String(),
  location: OptStr,
  onvifXaddr: OptStr,
  rtspUrl: OptStr,
  /** Optional credentials; the server stores the password in the OS keychain (credential_ref). */
  username: Type.Optional(Type.String()),
  password: Type.Optional(Type.String()),
  status: Type.Optional(Type.Enum([...CAMERA_STATUS])),
});
export type CameraInput = Static<typeof CameraInput>;

/** One camera tile on the barn map, in world px. Height is derived from w / ar, never stored. */
export const CameraMapTile = Type.Object({
  /** Camera id. */
  i: Type.String({ minLength: 1 }),
  x: Type.Number(),
  y: Type.Number(),
  w: Type.Number({ exclusiveMinimum: 0 }),
  /** Width / height of the camera frame. */
  ar: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
});
export type CameraMapTile = Static<typeof CameraMapTile>;

/** Farm-wide barn-map arrangement of camera tiles (shared through sync, one per farm). */
export const CameraMapLayout = Type.Object({
  version: Type.Literal(2),
  tiles: Type.Array(CameraMapTile, { maxItems: 500 }),
});
export type CameraMapLayout = Static<typeof CameraMapLayout>;

export const ObservationKindSchema = Type.Enum([...OBSERVATION_KINDS]);
