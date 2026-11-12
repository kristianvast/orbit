import type { SessionHeader } from "@earendil-works/pi-coding-agent";
import { SECRET_PATTERNS } from "@orbit/protocol";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { type ChatMetadata, cloudEntries, type HistoryEntry } from "../agent/chat-history";
import type { SessionHub } from "../agent/hub";
import type { AccountService } from "./account";

const Metadata = Type.Object({
  id: Type.String({ pattern: "^[0-9a-fA-F-]{36}$" }),
  title: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  parentSessionId: Type.Union([Type.String(), Type.Null()]),
  deletedAt: Type.Union([Type.String(), Type.Null()]),
});
const SessionPage = Type.Object({
  sessions: Type.Array(Metadata),
  next: Type.Union([Type.String(), Type.Null()]),
});
const EntryPage = Type.Object({
  header: Type.Object({
    type: Type.Literal("session"),
    version: Type.Number(),
    id: Type.String(),
    timestamp: Type.String(),
    cwd: Type.String(),
  }),
  entries: Type.Array(
    Type.Object(
      {
        id: Type.String(),
        parentId: Type.Union([Type.String(), Type.Null()]),
        timestamp: Type.String(),
        type: Type.String(),
      },
      { additionalProperties: true },
    ),
  ),
  next: Type.Union([Type.Number(), Type.Null()]),
});

/** JSONL remains the offline source of truth; Core stores the same immutable entry IDs. */
export class ChatSync {
  private timer: ReturnType<typeof setInterval>;
  private running: Promise<void> | null = null;
  private requested = false;
  private stopped = false;
  private owner: string | undefined;

  constructor(
    private readonly hub: SessionHub,
    private readonly account: AccountService,
  ) {
    hub.onHistoryChange = () => this.notify();
    this.timer = setInterval(() => this.notify(), 10_000);
    this.timer.unref();
  }

  accountChanged(): void {
    const status = this.account.status();
    const owner =
      status.state === "signed_in" && status.user
        ? `${status.user.id}:${status.farm?.id ?? "local"}`
        : undefined;
    this.owner = owner;
    this.notify();
  }

  notify(): void {
    if (this.stopped || !this.owner || !this.account.status().farm) return;
    this.requested = true;
    if (this.running) return;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
  }

  private async drain(): Promise<void> {
    while (this.requested && !this.stopped) {
      this.requested = false;
      try {
        await this.reconcile();
      } catch (error) {
        // The durable JSONL and index retain all writes for the next account refresh or tick.
        process.stderr.write(
          `orion: chat sync failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }

  private async reconcile(): Promise<void> {
    const owner = this.owner;
    if (!owner) return;
    const connection = this.account.cloudConnection();
    const current = () => this.owner === owner && !this.stopped;
    const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(`${connection.url}/v1/chat${path}`, {
        method,
        headers: { ...connection.headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`chat cloud answered ${response.status}`);
      return response.json();
    };
    const remote = new Map<string, ChatMetadata>();
    let after: string | null = null;
    do {
      const page: Static<typeof SessionPage> = Value.Parse(
        SessionPage,
        await request("GET", `/sessions${after ? `?after=${after}` : ""}`),
      );
      for (const session of page.sessions) remote.set(session.id, session);
      after = page.next;
    } while (after && current());
    if (!current()) return;
    const known = new Map<string, Set<string>>();
    for (const session of remote.values()) {
      if (!current()) return;
      if (session.deletedAt) {
        await this.hub.mergeHistory({ session, header: null, entries: [] });
        continue;
      }
      const entries: HistoryEntry[] = [];
      let cursor: number | null = null;
      let header: SessionHeader | null = null;
      do {
        const page: Static<typeof EntryPage> = Value.Parse(
          EntryPage,
          await request(
            "GET",
            `/sessions/${session.id}/entries${cursor ? `?after=${cursor}` : ""}`,
          ),
        );
        entries.push(...page.entries);
        header = page.header;
        cursor = page.next;
      } while (cursor && current());
      if (!current()) return;
      known.set(session.id, new Set(entries.map((e) => e.id)));
      await this.hub.mergeHistory({ session, header, entries });
    }
    for (const history of this.hub.histories()) {
      if (!current()) return;
      const { session, header } = history;
      const previous = remote.get(session.id);
      if (session.deletedAt) {
        if (!previous?.deletedAt) await request("DELETE", `/sessions/${session.id}`);
        continue;
      }
      if (previous?.deletedAt || !header || this.hub.isStreaming(session.id)) continue;
      const entries = cloudEntries(history.entries).filter(
        (e) => typeof e.id === "string" && !known.get(session.id)?.has(e.id),
      );
      if (previous && !entries.length && session.updatedAt <= previous.updatedAt) continue;
      const metadata = { ...session, title: cloudEntriesTitle(session.title) };
      const safeHeader = {
        type: "session",
        version: 3,
        id: session.id,
        timestamp: header.timestamp,
        cwd: ".",
      };
      // Entries are bounded separately by Core. Batch by bytes as images can dwarf text turns.
      let batch: Record<string, unknown>[] = [];
      let size = 0;
      const upload = async () => {
        await request("POST", `/sessions/${session.id}/entries`, {
          session: metadata,
          header: safeHeader,
          entries: batch,
        });
      };
      for (const e of entries) {
        const bytes = Buffer.byteLength(JSON.stringify(e));
        if (bytes > 512 * 1024) throw new Error(`chat entry ${e.id} exceeds cloud size limit`);
        if (batch.length === 100 || size + bytes > 900 * 1024) {
          await upload();
          batch = [];
          size = 0;
        }
        batch.push(e);
        size += bytes;
      }
      if (batch.length || !previous || session.updatedAt > previous.updatedAt) await upload();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.hub.onHistoryChange = () => {};
    await this.running;
  }
}

function cloudEntriesTitle(title: string): string {
  // Titles are derived from user text and can contain the same secrets as a message.
  return SECRET_PATTERNS.some((pattern) => pattern.test(title))
    ? "Private conversation"
    : title.slice(0, 200);
}
