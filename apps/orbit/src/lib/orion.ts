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

export interface OrionEndpoint {
  url: string;
  token: string;
}

export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

export async function resolveOrionEndpoint(): Promise<OrionEndpoint> {
  if (isTauriRuntime()) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const endpoint = await invoke<OrionEndpoint>("orion_endpoint");
        if (endpoint?.url && endpoint?.token) {
          return endpoint;
        }
      } catch {
        // Sidecar is still starting (migrating/seeding SQLite); retry shortly.
      }
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

    resolveOrionEndpoint().then((resolved) => {
      if (cancelled) return;
      setEndpoint(resolved);
      const created = createOrionClient(resolved.url, resolved.token, {
        clientName: "@orbit/app",
      });
      activeClient = created;
      setClient(created);
      setState(created.state);
      offState = created.onState((next) => {
        if (!cancelled) setState(next);
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
    });

    return () => {
      cancelled = true;
      offState?.();
      offSync?.();
      activeClient?.close();
    };
  }, [initialClient, connectEpoch]);

  const reconnect = useCallback(() => {
    setConnectEpoch((n) => n + 1);
  }, []);

  const value = useMemo<OrionContextValue>(
    () => ({
      client,
      state,
      endpoint,
      syncStatus,
      reconnect,
    }),
    [client, state, endpoint, syncStatus, reconnect],
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

export function OrionConnectionBanner() {
  const { state, endpoint, reconnect } = useOrion();

  if (state === "open") return null;

  const isAuthError = state === "unauthorized";
  const isConnecting = state === "connecting";

  const title = isAuthError
    ? "Orion rejected the security token"
    : isConnecting
      ? "Connecting to Orion on this farm PC…"
      : "Orion assistant is not reachable right now";

  const detail = isAuthError
    ? "Restart Orbit so a fresh local session token can be negotiated with Orion."
    : `Waiting for local Orion agent at ${endpoint?.url ?? DEV_SERVER_URL}. Your farm data stays safe on this PC and will appear automatically once connected.`;

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
          createElement(
            Badge,
            { variant: isAuthError ? "danger" : "warn" },
            state === "reconnecting" ? "Reconnecting" : state,
          ),
        ),
        createElement(
          "div",
          {
            style: {
              fontSize: "var(--text-xs)",
              color: "var(--text-secondary)",
            },
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
        onClick: reconnect,
        icon: createElement(RefreshCw, { size: 15 }),
      },
      "Retry connection",
    ),
  );
}
