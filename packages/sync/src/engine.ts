import type { Database } from "bun:sqlite";
import { createHlc, type Hlc, SYNCED_TABLES, type SyncedTable } from "@orbit/schema";
import { type ApplyContext, applyIncomingRow } from "./apply";
import { isSyncedTable } from "./columns";
import { toWireRow } from "./convert";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Same values as @orbit/protocol SyncState. */
export type SyncEngineState =
  | "disabled"
  | "offline"
  | "connecting"
  | "syncing"
  | "up_to_date"
  | "error";

export interface SyncStatus {
  state: SyncEngineState;
  pendingOutbox: number;
  lastSyncedAt: string | null;
  error?: string;
}

export interface ChangesEvent {
  table: SyncedTable;
  ids: string[];
}

export interface CycleResult {
  ok: boolean;
  pushed: number;
  pulled: number;
  error?: string;
}

export interface SyncEngineOptions {
  /** Local Orbit database (drizzle bun:sqlite from @orbit/schema/local). Must be migrated. */
  db: { $client: Database };
  farmId: string;
  /** Base URL of @core/api, e.g. https://core.example.com */
  coreUrl: string;
  token: string;
  /** Sent with every Core request, e.g. { "x-orbit-farm": farmId } for a user session token. */
  headers?: Record<string, string>;
  fetch?: FetchLike;
  /** Orion's clock. When omitted a clock is created from nodeId (or a persisted random id). */
  hlc?: Hlc;
  nodeId?: string;
  tables?: readonly SyncedTable[];
  batchSize?: number;
  /** Delay between successful cycles. Default 5000 ms. */
  intervalMs?: number;
  retry?: { baseMs?: number; maxMs?: number; jitter?: number };
  now?: () => Date;
}

export interface SyncEngine {
  start(): void;
  stop(): Promise<void>;
  /** Runs one push+pull cycle now (serialised with the background loop). Never throws. */
  syncNow(): Promise<CycleResult>;
  /** Hint that the outbox grew; schedules a cycle immediately when idle. */
  notifyLocalWrite(): void;
  setToken(token: string): void;
  status(): SyncStatus;
  on(event: "status", handler: (s: SyncStatus) => void): () => void;
  on(event: "changes", handler: (c: ChangesEvent) => void): () => void;
}

/** Network failure or 5xx/429: Core unreachable, try again later. */
export class SyncOfflineError extends Error {
  override name = "SyncOfflineError";
}
/** 401/403 or another non-retryable HTTP answer. */
export class SyncHttpError extends Error {
  override name = "SyncHttpError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface ShapeCursor {
  handle: string | null;
  offset: string;
}

interface ShapeMessage {
  key?: string;
  value?: Record<string, unknown>;
  headers?: { operation?: string; control?: string };
}

export interface PushResultItem {
  seq: number;
  status: "applied" | "stale" | "rejected" | "conflict";
  error?: string;
}

const MAX_PAGES_PER_TABLE = 1000;

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const client = options.db.$client;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const coreUrl = options.coreUrl.replace(/\/+$/, "");
  const tables = options.tables ?? SYNCED_TABLES;
  const batchSize = options.batchSize ?? 100;
  const intervalMs = options.intervalMs ?? 5000;
  const baseMs = options.retry?.baseMs ?? 1000;
  const maxMs = options.retry?.maxMs ?? 60_000;
  const jitter = options.retry?.jitter ?? 0.2;
  const now = options.now ?? (() => new Date());
  let token = options.token;

  const getState = <T>(key: string): T | undefined => {
    const row = client
      .query<{ value: string }, [string]>(`SELECT "value" FROM "sync_state" WHERE "key" = ?`)
      .get(key);
    return row ? (JSON.parse(row.value) as T) : undefined;
  };
  const setState = (key: string, value: unknown) => {
    client
      .query(
        `INSERT INTO "sync_state" ("key", "value", "updated_at") VALUES (?, ?, ?)
         ON CONFLICT("key") DO UPDATE SET "value" = excluded."value", "updated_at" = excluded."updated_at"`,
      )
      .run(key, JSON.stringify(value), now().toISOString());
  };

  let clock = options.hlc;
  if (!clock) {
    let nodeId = options.nodeId ?? getState<string>("nodeId");
    if (!nodeId) {
      nodeId = crypto.randomUUID();
      setState("nodeId", nodeId);
    }
    clock = createHlc(nodeId);
  }
  const ctx: ApplyContext = { client, clock, farmId: options.farmId, now };

  const statusHandlers = new Set<(s: SyncStatus) => void>();
  const changeHandlers = new Set<(c: ChangesEvent) => void>();
  const pendingCount = () =>
    client
      .query<{ n: number }, []>(`SELECT count(*) AS n FROM "outbox" WHERE "acked_at" IS NULL`)
      .get()?.n ?? 0;
  let current: SyncStatus = {
    state: "disabled",
    pendingOutbox: pendingCount(),
    lastSyncedAt: getState<string>("lastSyncedAt") ?? null,
  };
  const emit = (patch: Partial<SyncStatus>) => {
    const { error: _drop, ...rest } = current;
    current = { ...rest, ...patch, pendingOutbox: pendingCount() };
    for (const h of statusHandlers) h(current);
  };

  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let abort = new AbortController();
  let chain: Promise<unknown> = Promise.resolve();

  const authHeaders = () => ({ ...options.headers, authorization: `Bearer ${token}` });

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await doFetch(url, {
        ...init,
        headers: { ...authHeaders(), ...(init.headers as Record<string, string>) },
        signal: abort.signal,
      });
    } catch (err) {
      throw new SyncOfflineError(`Core unreachable: ${(err as Error).message}`);
    }
    if (res.status >= 500 || res.status === 429) {
      throw new SyncOfflineError(`Core answered ${res.status}`);
    }
    return res;
  }

  async function push(): Promise<number> {
    let pushed = 0;
    let cursor = 0;
    for (;;) {
      const batch = client
        .query<
          {
            seq: number;
            op: string;
            table_name: string;
            row_id: string;
            payload: string;
            hlc: string;
          },
          [number, number]
        >(
          `SELECT "seq", "op", "table_name", "row_id", "payload", "hlc" FROM "outbox"
           WHERE "acked_at" IS NULL AND "seq" > ? ORDER BY "seq" LIMIT ?`,
        )
        .all(cursor, batchSize);
      if (batch.length === 0) return pushed;
      cursor = batch[batch.length - 1]?.seq ?? cursor;
      const changes = batch.map((e) => ({
        seq: e.seq,
        op: e.op,
        table: e.table_name,
        rowId: e.row_id,
        hlc: e.hlc,
        row: isSyncedTable(e.table_name)
          ? toWireRow(e.table_name, JSON.parse(e.payload) as Record<string, unknown>)
          : JSON.parse(e.payload),
      }));
      const markFailed = client.prepare(
        `UPDATE "outbox" SET "attempts" = "attempts" + 1, "last_error" = ? WHERE "seq" = ?`,
      );
      let res: Response;
      try {
        res = await request(`${coreUrl}/v1/changes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ changes }),
        });
        if (!res.ok) {
          throw new SyncHttpError(
            res.status,
            `POST /v1/changes ${res.status}: ${await res.text()}`,
          );
        }
      } catch (err) {
        client.transaction(() => {
          for (const e of batch) markFailed.run((err as Error).message, e.seq);
        })();
        throw err;
      }
      const body = (await res.json()) as { results?: PushResultItem[] };
      const bySeq = new Map((body.results ?? []).map((r) => [r.seq, r]));
      const ackedAt = now().toISOString();
      const ack = client.prepare(
        `UPDATE "outbox" SET "acked_at" = ?, "last_error" = ? WHERE "seq" = ?`,
      );
      client.transaction(() => {
        for (const e of batch) {
          const r = bySeq.get(e.seq);
          if (!r) markFailed.run("missing from Core response", e.seq);
          else if (r.status === "applied" || r.status === "stale") {
            ack.run(ackedAt, null, e.seq);
            pushed++;
          } else if (r.status === "rejected") ack.run(ackedAt, `rejected: ${r.error ?? ""}`, e.seq);
          else markFailed.run(`${r.status}: ${r.error ?? ""}`, e.seq);
        }
      })();
    }
  }

  async function pullTable(table: SyncedTable): Promise<number> {
    let applied = 0;
    for (let page = 0; page < MAX_PAGES_PER_TABLE; page++) {
      const cursor = getState<ShapeCursor>(`shape:${table}`) ?? { handle: null, offset: "-1" };
      const params = new URLSearchParams({ table, offset: cursor.offset });
      if (cursor.handle) params.set("handle", cursor.handle);
      const res = await request(`${coreUrl}/v1/shape?${params}`);
      if (res.status === 409) {
        await res.body?.cancel();
        setState(`shape:${table}`, { handle: res.headers.get("electric-handle"), offset: "-1" });
        continue;
      }
      if (!res.ok) {
        throw new SyncHttpError(
          res.status,
          `GET /v1/shape ${table} ${res.status}: ${await res.text()}`,
        );
      }
      const messages = res.status === 204 ? [] : ((await res.json()) as ShapeMessage[]);
      const next: ShapeCursor = {
        handle: res.headers.get("electric-handle") ?? cursor.handle,
        offset: res.headers.get("electric-offset") ?? cursor.offset,
      };
      let upToDate = res.status === 204 || res.headers.has("electric-up-to-date");
      let mustRefetch = false;
      const ids: string[] = [];
      client.transaction(() => {
        for (const m of messages) {
          const control = m.headers?.control;
          if (control === "up-to-date") upToDate = true;
          else if (control === "must-refetch") mustRefetch = true;
          const op = m.headers?.operation;
          // Rows are never hard-deleted; an Electric "delete" only means the row left the shape.
          if ((op === "insert" || op === "update") && m.value) {
            if (applyIncomingRow(ctx, table, m.value) === "applied") ids.push(String(m.value.id));
          }
        }
        setState(`shape:${table}`, mustRefetch ? { handle: null, offset: "-1" } : next);
      })();
      applied += ids.length;
      if (ids.length > 0) for (const h of changeHandlers) h({ table, ids });
      if (upToDate && !mustRefetch) return applied;
    }
    return applied;
  }

  async function cycle(): Promise<CycleResult> {
    emit({ state: current.state === "up_to_date" ? "syncing" : "connecting" });
    try {
      const pushed = await push();
      emit({ state: "syncing" });
      let pulled = 0;
      for (const t of tables) pulled += await pullTable(t);
      const lastSyncedAt = now().toISOString();
      setState("lastSyncedAt", lastSyncedAt);
      failures = 0;
      emit({ state: "up_to_date", lastSyncedAt });
      return { ok: true, pushed, pulled };
    } catch (err) {
      failures++;
      const message = (err as Error).message;
      const aborted = abort.signal.aborted;
      if (!aborted)
        emit({ state: err instanceof SyncOfflineError ? "offline" : "error", error: message });
      return { ok: false, pushed: 0, pulled: 0, error: message };
    }
  }

  const enqueue = (): Promise<CycleResult> => {
    const p = chain.then(cycle);
    chain = p.catch(() => undefined);
    return p;
  };

  function backoffMs(): number {
    const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1));
    return Math.round(raw * (1 + jitter * Math.random()));
  }

  function schedule(delay: number) {
    if (!running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      const result = await enqueue();
      schedule(result.ok ? intervalMs : backoffMs());
    }, delay);
  }

  return {
    start() {
      if (running) return;
      running = true;
      abort = new AbortController();
      schedule(0);
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      abort.abort();
      await chain;
      abort = new AbortController();
      emit({ state: "disabled" });
    },
    syncNow: enqueue,
    notifyLocalWrite() {
      emit({});
      if (running && timer && failures === 0) schedule(0);
    },
    setToken(next) {
      token = next;
      if (running) schedule(0);
    },
    status: () => current,
    on(event: "status" | "changes", handler: (arg: never) => void) {
      const set = (event === "status" ? statusHandlers : changeHandlers) as Set<typeof handler>;
      set.add(handler);
      return () => set.delete(handler);
    },
  } as SyncEngine;
}
