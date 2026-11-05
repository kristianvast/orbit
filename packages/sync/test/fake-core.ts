import type { SyncedTable } from "@orbit/schema";
import { type LocalDb, migrate, openLocalDb } from "@orbit/schema/local";
import type { PushResultItem } from "../src";

export const FARM = "00000000-0000-4000-8000-000000000001";
export const TOKEN = "farm-token";

export interface PushedChange {
  seq: number;
  op: string;
  table: string;
  rowId: string;
  hlc: string;
  row: Record<string, unknown>;
}

type Responder = (changes: PushedChange[]) => Response | PushResultItem[];

/** Minimal Electric-compatible shape endpoint plus the Core write API, in memory. */
export class FakeCore {
  readonly log = new Map<string, { offset: number; value: Record<string, unknown> }[]>();
  readonly pushes: PushedChange[][] = [];
  readonly shapeRequests: URLSearchParams[] = [];
  readonly farmHeaders: (string | null)[] = [];
  handle = "handle-1";
  pushResponder: Responder = (changes) => changes.map((c) => ({ seq: c.seq, status: "applied" }));
  shapeResponder: ((params: URLSearchParams) => Response | undefined) | null = null;
  private nextOffset = 1;
  private server: ReturnType<typeof Bun.serve>;

  constructor() {
    this.server = Bun.serve({ port: 0, fetch: (req) => this.handle_(req) });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  /** Appends a row (Postgres text encoding) to a table's shape log. */
  emit(table: SyncedTable, value: Record<string, unknown>): void {
    const rows = this.log.get(table) ?? [];
    rows.push({ offset: this.nextOffset++, value });
    this.log.set(table, rows);
  }

  stop(): void {
    this.server.stop(true);
  }

  private async handle_(req: Request): Promise<Response> {
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return new Response("unauthorized", { status: 401 });
    }
    this.farmHeaders.push(req.headers.get("x-orbit-farm"));
    const url = new URL(req.url);
    if (url.pathname === "/v1/shape") {
      this.shapeRequests.push(url.searchParams);
      const custom = this.shapeResponder?.(url.searchParams);
      if (custom) return custom;
      const table = url.searchParams.get("table") ?? "";
      const offset = url.searchParams.get("offset") ?? "-1";
      const after = offset === "-1" ? 0 : Number(offset.split("_")[0]);
      const rows = (this.log.get(table) ?? []).filter((r) => r.offset > after);
      const last = rows.at(-1)?.offset ?? after;
      const body = [
        ...rows.map((r) => ({
          key: `"public"."${table}"/"${r.value.id}"`,
          value: r.value,
          headers: { operation: after === 0 ? "insert" : "update" },
        })),
        { headers: { control: "up-to-date" } },
      ];
      return Response.json(body, {
        headers: {
          "electric-handle": this.handle,
          "electric-offset": `${last}_0`,
          "electric-up-to-date": "",
        },
      });
    }
    if (url.pathname === "/v1/changes" && req.method === "POST") {
      const { changes } = (await req.json()) as { changes: PushedChange[] };
      this.pushes.push(changes);
      const out = this.pushResponder(changes);
      return out instanceof Response ? out : Response.json({ results: out });
    }
    return new Response("not found", { status: 404 });
  }
}

export function freshDb(): LocalDb {
  const db = openLocalDb(":memory:");
  migrate(db);
  return db;
}

export function hlcAt(iso: string, counter = 0, node = "cloud"): string {
  return `${String(Date.parse(iso)).padStart(15, "0")}:${String(counter).padStart(6, "0")}:${node}`;
}

/** An animals row as Electric would stream it (Postgres text values). */
export function pgAnimal(id: string, hlc: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    species: "cattle",
    name: "Dagros",
    ear_tag_number: "1001",
    national_id: null,
    breed: "Holstein",
    sex: "female",
    birth_date: "2022-03-01",
    group_name: "milking",
    status: "active",
    notes: null,
    farm_id: FARM,
    created_at: "2026-11-01 08:00:00+00",
    updated_at: "2026-11-01 08:00:00.123456+00",
    deleted_at: null,
    hlc,
    origin_device: "cloud",
    ...extra,
  };
}
