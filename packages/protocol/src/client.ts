// Browser-safe typed client for the Orion WebSocket protocol, with auto-reconnect.
import { decodeServerMessage, encodeRequest, validateResult } from "./codec";
import type {
  DbMutateResult,
  DbMutationName,
  DbMutationParams,
  DbQueryName,
  DbQueryParams,
  DbQueryResults,
} from "./db";
import type {
  EventFrame,
  EventType,
  RequestParams,
  RequestResult,
  RequestType,
  ServerEvent,
} from "./messages";
import { CloseCode, type ErrorCode, PROTOCOL_VERSION, type ProtocolError } from "./model";

export type ConnectionState = "connecting" | "open" | "reconnecting" | "unauthorized" | "closed";

export class OrionRequestError extends Error {
  override name = "OrionRequestError";
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface OrionClientOptions {
  /** WebSocket constructor; defaults to globalThis.WebSocket. */
  WebSocket?: typeof WebSocket;
  /** Per-request timeout. Default 30 000 ms. */
  requestTimeoutMs?: number;
  /** Reconnect backoff; false disables reconnecting. Default { minDelayMs: 250, maxDelayMs: 5000 }. */
  reconnect?: false | { minDelayMs?: number; maxDelayMs?: number };
  /** Validate response results against the protocol schemas. Default true. */
  validateResults?: boolean;
  /** Client name sent in hello. */
  clientName?: string;
}

type ParamsArg<T extends RequestType> =
  Record<string, never> extends RequestParams<T>
    ? [params?: RequestParams<T>]
    : [params: RequestParams<T>];

export type ClientRequestType = Exclude<RequestType, "hello">;

export interface OrionClient {
  readonly state: ConnectionState;
  /** Server info from the last successful hello. */
  readonly server: RequestResult<"hello"> | null;
  /** Sends a request. Queued while (re)connecting; rejects with OrionRequestError. */
  request<T extends ClientRequestType>(type: T, ...params: ParamsArg<T>): Promise<RequestResult<T>>;
  /** Typed db.query helper. */
  query<Q extends DbQueryName>(query: Q, params?: DbQueryParams<Q>): Promise<DbQueryResults[Q]>;
  /** Typed db.mutate helper. */
  mutate<M extends DbMutationName>(
    mutation: M,
    params: DbMutationParams<M>,
  ): Promise<DbMutateResult>;
  /** Subscribe to one event type, or "*" for all events. Returns an unsubscribe function. */
  on<E extends EventType>(type: E, handler: (event: EventFrame<E>) => void): () => void;
  on(type: "*", handler: (event: ServerEvent) => void): () => void;
  onState(handler: (state: ConnectionState) => void): () => void;
  /** Resolves after the next successful hello (immediately if open). */
  ready(): Promise<void>;
  close(): void;
}

interface Pending {
  type: RequestType;
  frame: string;
  sent: boolean;
  resolve: (value: unknown) => void;
  reject: (error: OrionRequestError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createOrionClient(
  url: string,
  token: string,
  options: OrionClientOptions = {},
): OrionClient {
  const WS = options.WebSocket ?? globalThis.WebSocket;
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  const backoff =
    options.reconnect === false
      ? null
      : { minDelayMs: 250, maxDelayMs: 5_000, ...options.reconnect };
  const validate = options.validateResults ?? true;

  let state: ConnectionState = "connecting";
  let server: RequestResult<"hello"> | null = null;
  let socket: WebSocket | null = null;
  let seq = 0;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let helloId: string | null = null;
  const pending = new Map<string, Pending>();
  const listeners = new Map<string, Set<(event: ServerEvent) => void>>();
  const stateListeners = new Set<(state: ConnectionState) => void>();
  let readyWaiters: { resolve: () => void; reject: (e: OrionRequestError) => void }[] = [];

  const setState = (next: ConnectionState) => {
    if (state === next) return;
    state = next;
    for (const l of stateListeners) l(next);
  };

  const failAll = (filter: (p: Pending) => boolean, code: ErrorCode, message: string) => {
    for (const [id, p] of pending) {
      if (!filter(p)) continue;
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(new OrionRequestError(code, message));
    }
  };

  const terminal = (next: "unauthorized" | "closed", message: string) => {
    setState(next);
    const code: ErrorCode = next === "unauthorized" ? "unauthorized" : "disconnected";
    failAll(() => true, code, message);
    for (const w of readyWaiters) w.reject(new OrionRequestError(code, message));
    readyWaiters = [];
  };

  const flush = () => {
    if (!socket || state !== "open") return;
    for (const p of pending.values()) {
      if (!p.sent) {
        socket.send(p.frame);
        p.sent = true;
      }
    }
  };

  const scheduleReconnect = () => {
    if (!backoff) {
      terminal("closed", "connection closed");
      return;
    }
    setState("reconnecting");
    const delay = Math.min(backoff.maxDelayMs, backoff.minDelayMs * 2 ** attempt);
    attempt++;
    reconnectTimer = setTimeout(connect, delay);
  };

  const onFrame = (data: unknown) => {
    const decoded = decodeServerMessage(data as string);
    if (!decoded.ok) return;
    const msg = decoded.value;
    if (msg.type === "response") {
      if (msg.id === helloId) {
        helloId = null;
        if (msg.ok) {
          server = msg.result as RequestResult<"hello">;
          attempt = 0;
          setState("open");
          for (const w of readyWaiters) w.resolve();
          readyWaiters = [];
          flush();
        } else if (msg.error.code === "unauthorized") {
          socket?.close();
          terminal("unauthorized", msg.error.message);
        }
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (!msg.ok) {
        p.reject(new OrionRequestError(msg.error.code, msg.error.message, msg.error.details));
        return;
      }
      if (validate) {
        const checked = validateResult(p.type, msg.result);
        if (!checked.ok) {
          p.reject(new OrionRequestError("internal", checked.error));
          return;
        }
      }
      p.resolve(msg.result);
      return;
    }
    for (const key of [msg.type, "*"]) {
      for (const l of listeners.get(key) ?? []) l(msg);
    }
  };

  function connect() {
    reconnectTimer = null;
    if (state === "closed" || state === "unauthorized") return;
    const ws = new WS(url);
    socket = ws;
    ws.onopen = () => {
      helloId = `hello-${++seq}`;
      ws.send(
        encodeRequest(helloId, "hello", {
          token,
          protocolVersion: PROTOCOL_VERSION,
          ...(options.clientName ? { client: options.clientName } : {}),
        }),
      );
    };
    ws.onmessage = (ev) => onFrame(ev.data);
    ws.onclose = (ev) => {
      if (socket !== ws) return;
      socket = null;
      helloId = null;
      if (state === "closed" || state === "unauthorized") return;
      if (ev.code === CloseCode.unauthorized) {
        terminal("unauthorized", "token rejected by Orion");
        return;
      }
      // Requests already on the wire may or may not have run: fail them. Unsent ones stay queued.
      failAll((p) => p.sent, "disconnected", "connection lost before a response arrived");
      scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows and drives reconnect.
    };
  }

  const request = (type: RequestType, params?: unknown): Promise<unknown> => {
    if (state === "closed" || state === "unauthorized") {
      return Promise.reject(
        new OrionRequestError(
          state === "closed" ? "disconnected" : "unauthorized",
          `client is ${state}`,
        ),
      );
    }
    const id = `r${++seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new OrionRequestError("timeout", `${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // biome-ignore lint/suspicious/noExplicitAny: params were type-checked by the public signature
      const frame = encodeRequest(id, type, (params ?? {}) as any);
      pending.set(id, { type, frame, sent: false, resolve, reject, timer });
      flush();
    });
  };

  connect();

  const client: OrionClient = {
    get state() {
      return state;
    },
    get server() {
      return server;
    },
    request: request as OrionClient["request"],
    query: (query, params) =>
      request("db.query", { query, params: params ?? {} }) as Promise<DbQueryResults[typeof query]>,
    mutate: (mutation, params) =>
      request("db.mutate", { mutation, params }) as Promise<DbMutateResult>,
    on(type: string, handler: (event: never) => void) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      const h = handler as (event: ServerEvent) => void;
      set.add(h);
      return () => set.delete(h);
    },
    onState(handler) {
      stateListeners.add(handler);
      return () => stateListeners.delete(handler);
    },
    ready() {
      if (state === "open") return Promise.resolve();
      if (state === "closed" || state === "unauthorized") {
        return Promise.reject(
          new OrionRequestError(
            state === "closed" ? "disconnected" : "unauthorized",
            `client is ${state}`,
          ),
        );
      }
      return new Promise((resolve, reject) => readyWaiters.push({ resolve, reject }));
    },
    close() {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const ws = socket;
      terminal("closed", "client closed");
      socket = null;
      ws?.close();
    },
  };
  return client;
}

export type { ProtocolError };
