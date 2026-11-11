import {
  type ConnectionState,
  createOrionClient,
  type DbQueryName,
  type DbQueryParams,
  type DbQueryResults,
  DEV_SERVER_URL,
  DEV_TOKEN,
  type EventFrame,
  type EventType,
  type OrionClient,
  type ServerEvent,
} from "@orbit/protocol";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, RefreshCw, WifiOff } from "lucide-react";
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Badge, Button } from "../design";
import { type MessageKey, useT } from "../i18n";
import { localUiEndpoint } from "./local-ui-path";

export interface OrionEndpoint {
  url: string;
  token: string;
}

export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

export type ShellOrionStatus =
  | { kind: "ready"; endpoint: OrionEndpoint }
  | { kind: "starting" }
  | { kind: "stopped"; reason: string };

/** The desktop shell rejects `orion_endpoint` with `starting` or `stopped: <reason>`. */
export function parseShellOrionError(error: unknown): ShellOrionStatus {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return text.startsWith("stopped: ")
    ? { kind: "stopped", reason: text.slice("stopped: ".length) }
    : { kind: "starting" };
}

async function readShellOrion(): Promise<ShellOrionStatus> {
  try {
    const endpoint = await invoke<OrionEndpoint>("orion_endpoint");
    return endpoint?.url && endpoint?.token ? { kind: "ready", endpoint } : { kind: "starting" };
  } catch (error) {
    return parseShellOrionError(error);
  }
}

export class OrionStoppedError extends Error {
  override name = "OrionStoppedError";
}

export async function resolveOrionEndpoint(): Promise<OrionEndpoint> {
  const local = localUiEndpoint();
  if (local) return local;
  if (isTauriRuntime()) {
    for (;;) {
      const status = await readShellOrion();
      if (status.kind === "ready") return status.endpoint;
      if (status.kind === "stopped") throw new OrionStoppedError(status.reason);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const envUrl = import.meta.env?.VITE_ORION_URL as string | undefined;
  const envToken = import.meta.env?.VITE_ORION_TOKEN as string | undefined;

  return {
    url: envUrl && envUrl.length > 0 ? envUrl : DEV_SERVER_URL,
    token: envToken && envToken.length > 0 ? envToken : DEV_TOKEN,
  };
}

export interface SyncStatusSnapshot {
  state: EventFrame<"sync.status">["state"];
  pendingOutbox: number;
  lastSyncedAt: string | null;
  error?: string;
}

export interface OrionContextValue {
  client: OrionClient | null;
  state: ConnectionState;
  endpoint: OrionEndpoint | null;
  syncStatus: SyncStatusSnapshot;
  reconnect: () => void;
  /** Desktop only: why the Orion sidecar is not running after the shell gave up restarting it. */
  stopped: string | null;
  restart: () => void;
}

const DEFAULT_SYNC_STATUS: SyncStatusSnapshot = {
  state: "up_to_date",
  pendingOutbox: 0,
  lastSyncedAt: null,
};

const OrionContext = createContext<OrionContextValue | null>(null);

export interface OrionProviderProps {
  children: ReactNode;
  initialClient?: OrionClient;
  initialEndpoint?: OrionEndpoint;
}

export function OrionProvider({ children, initialClient, initialEndpoint }: OrionProviderProps) {
  const [client, setClient] = useState<OrionClient | null>(initialClient ?? null);
  const [endpoint, setEndpoint] = useState<OrionEndpoint | null>(initialEndpoint ?? null);
  const [state, setState] = useState<ConnectionState>(
    initialClient ? initialClient.state : "connecting",
  );
  const [syncStatus, setSyncStatus] = useState<SyncStatusSnapshot>(DEFAULT_SYNC_STATUS);
  const [connectEpoch, setConnectEpoch] = useState(0);
  const [stopped, setStopped] = useState<string | null>(null);

  useEffect(() => {
    void connectEpoch;
    if (initialClient) {
      setClient(initialClient);
      setState(initialClient.state);
      const offState = initialClient.onState((next) => setState(next));
      const offSync = initialClient.on("sync.status", (ev) => {
        setSyncStatus({
          state: ev.state,
          pendingOutbox: ev.pendingOutbox,
          lastSyncedAt: ev.lastSyncedAt,
          error: ev.error,
        });
      });
      return () => {
        offState();
        offSync();
      };
    }

    let cancelled = false;
    let activeClient: OrionClient | null = null;
    let offState: (() => void) | null = null;
    let offSync: (() => void) | null = null;
    let shellWatch: ReturnType<typeof setInterval> | null = null;

    // A restarted sidecar listens on a new port with a new token, so the old client can never
    // reconnect: while it retries, ask the shell for the current endpoint and switch to it.
    const watchShell = (current: OrionEndpoint) => {
      if (shellWatch || !isTauriRuntime() || localUiEndpoint()) return;
      shellWatch = setInterval(() => {
        void readShellOrion().then((status) => {
          if (cancelled) return;
          if (status.kind === "stopped") setStopped(status.reason);
          if (
            status.kind === "ready" &&
            (status.endpoint.url !== current.url || status.endpoint.token !== current.token)
          ) {
            setConnectEpoch((n) => n + 1);
          }
        });
      }, 1000);
    };
    const stopWatch = () => {
      if (shellWatch) clearInterval(shellWatch);
      shellWatch = null;
    };

    resolveOrionEndpoint().then(
      (resolved) => {
        if (cancelled) return;
        setStopped(null);
        setEndpoint(resolved);
        const created = createOrionClient(resolved.url, resolved.token, {
          clientName: "@orbit/app",
        });
        activeClient = created;
        setClient(created);
        setState(created.state);
        offState = created.onState((next) => {
          if (cancelled) return;
          setState(next);
          if (next === "reconnecting") watchShell(resolved);
          else stopWatch();
        });
        offSync = created.on("sync.status", (ev) => {
          if (!cancelled) {
            setSyncStatus({
              state: ev.state,
              pendingOutbox: ev.pendingOutbox,
              lastSyncedAt: ev.lastSyncedAt,
              error: ev.error,
            });
          }
        });
      },
      (error: unknown) => {
        if (!cancelled && error instanceof OrionStoppedError) setStopped(error.message);
      },
    );

    return () => {
      cancelled = true;
      stopWatch();
      offState?.();
      offSync?.();
      activeClient?.close();
    };
  }, [initialClient, connectEpoch]);

  const reconnect = useCallback(() => {
    setConnectEpoch((n) => n + 1);
  }, []);

  const restart = useCallback(() => {
    setStopped(null);
    invoke("orion_restart").then(
      () => setConnectEpoch((n) => n + 1),
      (error: unknown) => setStopped(String(error)),
    );
  }, []);

  const value = useMemo<OrionContextValue>(
    () => ({
      client,
      state,
      endpoint,
      syncStatus,
      reconnect,
      stopped,
      restart,
    }),
    [client, state, endpoint, syncStatus, reconnect, stopped, restart],
  );

  return createElement(OrionContext.Provider, { value }, children);
}

export function useOrion(): OrionContextValue {
  const ctx = useContext(OrionContext);
  if (!ctx) {
    throw new Error("useOrion must be used within an <OrionProvider>");
  }
  return ctx;
}

export function useOrionEvent<E extends EventType>(
  type: E,
  handler: (event: EventFrame<E>) => void,
): void;
export function useOrionEvent(type: "*", handler: (event: ServerEvent) => void): void;
export function useOrionEvent(type: EventType | "*", handler: (event: never) => void): void {
  const { client } = useOrion();
  const savedHandler = useRef(handler);
  savedHandler.current = handler;

  useEffect(() => {
    if (!client) return;
    const listener = (ev: never) => {
      savedHandler.current(ev);
    };
    if (type === "*") {
      return client.on("*", listener as (event: ServerEvent) => void);
    }
    return client.on(type, listener as (event: EventFrame<EventType>) => void);
  }, [client, type]);
}

export interface UseOrionQueryOptions {
  enabled?: boolean;
  refetchTables?: string[];
}

export interface UseOrionQueryResult<Q extends DbQueryName> {
  data: DbQueryResults[Q] | null;
  error: Error | null;
  loading: boolean;
  refetch: () => Promise<void>;
}

export function useOrionQuery<Q extends DbQueryName>(
  query: Q,
  params?: DbQueryParams<Q>,
  options: UseOrionQueryOptions = {},
): UseOrionQueryResult<Q> {
  const { client, state } = useOrion();
  const enabled = options.enabled ?? true;
  const serializedParams = JSON.stringify(params ?? {});
  const [data, setData] = useState<DbQueryResults[Q] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const execute = useCallback(async () => {
    if (!client || !enabled) return;
    setLoading(true);
    setError(null);
    try {
      const parsedParams = JSON.parse(serializedParams) as DbQueryParams<Q>;
      const result = await client.query(query, parsedParams);
      if (mountedRef.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [client, enabled, query, serializedParams]);

  useEffect(() => {
    if (!enabled || !client) return;
    if (state === "open" || state === "connecting") {
      void execute();
    }
  }, [client, enabled, state, execute]);

  useEffect(() => {
    if (!client || !enabled) return;
    return client.on("db.changed", (ev) => {
      if (
        !options.refetchTables ||
        options.refetchTables.length === 0 ||
        options.refetchTables.includes(ev.table)
      ) {
        void execute();
      }
    });
  }, [client, enabled, execute, options.refetchTables]);

  return {
    data,
    error,
    loading,
    refetch: execute,
  };
}

const BANNER_STATE_KEYS: Record<Exclude<ConnectionState, "open">, MessageKey> = {
  connecting: "connection.state.connecting",
  reconnecting: "connection.state.reconnecting",
  closed: "connection.state.closed",
  unauthorized: "connection.state.unauthorized",
};

export function OrionConnectionBanner() {
  const { state, endpoint, reconnect, stopped, restart } = useOrion();
  const t = useT();

  if (state === "open" && !stopped) return null;

  const isAuthError = state === "unauthorized" || stopped !== null;
  const isConnecting = state === "connecting";

  const title = stopped
    ? t("connection.title.stopped")
    : state === "unauthorized"
      ? t("connection.title.unauthorized")
      : isConnecting
        ? t("connection.title.connecting")
        : t("connection.title.unreachable");

  const detail = stopped
    ? t("connection.detail.stopped", { reason: stopped })
    : state === "unauthorized"
      ? t("connection.detail.unauthorized")
      : t("connection.detail.waiting", { url: endpoint?.url ?? DEV_SERVER_URL });
  const badgeKey = stopped
    ? "connection.state.stopped"
    : BANNER_STATE_KEYS[state as Exclude<ConnectionState, "open">];

  return createElement(
    "div",
    {
      role: "status",
      "aria-live": "polite",
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: "var(--space-4)",
        padding: "var(--space-3) var(--space-5)",
        backgroundColor: isAuthError ? "var(--status-danger-bg)" : "var(--status-warn-bg)",
        borderBlockEnd: `1px solid ${
          isAuthError ? "var(--status-danger-border)" : "var(--status-warn-border)"
        }`,
        color: "var(--text-primary)",
      },
    },
    createElement(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          minInlineSize: 0,
        },
      },
      isAuthError
        ? createElement(AlertTriangle, {
            size: 20,
            style: { color: "var(--status-danger)", flexShrink: 0 },
          })
        : createElement(WifiOff, {
            size: 20,
            style: { color: "var(--status-warn)", flexShrink: 0 },
          }),
      createElement(
        "div",
        { style: { minInlineSize: 0 } },
        createElement(
          "div",
          {
            style: {
              fontWeight: 600,
              fontSize: "var(--text-sm)",
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
            },
          },
          title,
          createElement(Badge, { variant: isAuthError ? "danger" : "warn" }, t(badgeKey)),
        ),
        createElement(
          "div",
          {
            style: {
              fontSize: "var(--text-xs)",
              color: "var(--text-secondary)",
              whiteSpace: "pre-wrap",
            },
            "data-testid": "orion-connection-detail",
          },
          detail,
        ),
      ),
    ),
    createElement(
      Button,
      {
        variant: "secondary",
        size: "sm",
        onClick: stopped ? restart : reconnect,
        icon: createElement(RefreshCw, { size: 15 }),
      },
      t(stopped ? "connection.restart" : "connection.retry"),
    ),
  );
}
