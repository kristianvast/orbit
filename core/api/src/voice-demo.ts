// Public voice demo for the marketing website: mints a short-lived ElevenLabs Conversational AI
// credential for one fixed demo agent so a visitor can talk to Orion without an account.
// Unrelated to voice.ts (the authenticated Gemini Live gateway for paid farms).
//
// Abuse limits:
// - Each visitor gets `allowanceSeconds` of talk per rolling `allowanceWindowMs`, stored in
//   Postgres so hanging up, reloading, another instance or a restart never resets it. A call is
//   charged its real length as reported by ElevenLabs (the credential is minted with its
//   conversation_id); until that is known it counts as its full reservation, so an open or
//   unverifiable call blocks the next one. Reservations per visitor are serialized with an
//   advisory lock, so parallel requests cannot double-spend.
// - The visitor is the last X-Forwarded-For hop, the address Cloud Run's front end appends (any
//   earlier hops are client-supplied and ignored); IPv6 addresses count per /64. Only an HMAC of
//   it is stored.
// - The agent's own max_duration_seconds (ElevenLabs config) is the hard cap per call; keep it at
//   `maxSeconds`. A client that ignores max_seconds is still charged the real length.
// - `perIp` sessions per `windowMs` (in memory) and `daily` sessions per UTC day (all visitors)
//   remain as burst and spend backstops.
import { createHmac } from "node:crypto";
import { and, asc, eq, gt, gte, lt, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { type CoreDb, voiceDemoSessions } from "./db";
import type { FetchLike } from "./shape";

export type DemoVoice = "female" | "male";

export interface VoiceDemoOptions {
  db: CoreDb;
  apiKey?: string;
  agentId?: string;
  voices: Record<DemoVoice, { id: string; name: string }>;
  perIp: number;
  windowMs: number;
  daily: number;
  maxSeconds: number;
  allowanceSeconds: number;
  allowanceWindowMs: number;
  /** A new call needs at least this much allowance left. */
  minSeconds: number;
  /** A minted credential that never became a conversation is refunded after this long. */
  unusedRefundMs: number;
  apiBase: string;
  fetch: FetchLike;
  now: () => Date;
}

export const VOICE_DEMO_DEFAULTS = {
  voices: {
    female: { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah" },
    male: { id: "iP95p4xoKVk53GoZ742B", name: "Chris" },
  },
  perIp: 5,
  windowMs: 10 * 60_000,
  daily: 300,
  maxSeconds: 180,
  allowanceSeconds: 180,
  allowanceWindowMs: 25 * 3_600_000,
  minSeconds: 10,
  unusedRefundMs: 15 * 60_000,
  apiBase: "https://api.elevenlabs.io",
} satisfies Partial<VoiceDemoOptions>;

const DAY_MS = 86_400_000;
const ACTIVE_RETRY_SECONDS = 5;
const SETTLED = new Set(["done", "processing", "failed"]);

/** The client address Cloud Run saw: the last X-Forwarded-For hop. */
export function clientIp(forwardedFor: string | undefined): string {
  return forwardedFor?.split(",").at(-1)?.trim() || "unknown";
}

/** IPv4 as is, IPv6 reduced to its /64 so one household or host cannot rotate addresses. */
export function visitorKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  if (!ip.includes(":")) return ip;
  const bare =
    ip
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .split("%")[0] ?? "";
  const [head = "", tail] = bare.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  const prefix = groups.slice(0, 4).map((g) => Number.parseInt(g || "0", 16));
  if (prefix.length < 4 || prefix.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff))
    return bare;
  return `${prefix.map((n) => n.toString(16)).join(":")}::/64`;
}

function createBurstLimiter(opts: Pick<VoiceDemoOptions, "perIp" | "windowMs">) {
  const hits = new Map<string, number[]>();
  /** Records a session and returns 0, or returns the seconds to wait when over the limit. */
  return (key: string, t: number): number => {
    if (hits.size > 10_000) {
      for (const [k, list] of hits) {
        if ((list.at(-1) ?? 0) <= t - opts.windowMs) hits.delete(k);
      }
    }
    const recent = (hits.get(key) ?? []).filter((at) => at > t - opts.windowMs);
    const oldest = recent[0];
    if (oldest !== undefined && recent.length >= opts.perIp) {
      hits.set(key, recent);
      return Math.max(1, Math.ceil((oldest + opts.windowMs - t) / 1000));
    }
    recent.push(t);
    hits.set(key, recent);
    return 0;
  };
}

type SessionRow = typeof voiceDemoSessions.$inferSelect;
interface Charge {
  seconds: number;
  /** The charge is the real call length (or a refund) and can be stored. */
  settled: boolean;
  /** The call may still be running or about to start. */
  active: boolean;
}
export interface Allowance {
  remaining: number;
  retryAfter: number;
  active: boolean;
}

const fail = (
  c: Context,
  status: 400 | 429 | 502 | 503,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) => c.json({ error: { code, message }, ...extra }, status);

export function registerVoiceDemoRoutes(app: Hono, opts: VoiceDemoOptions) {
  const burst = createBurstLimiter(opts);
  const db = opts.db;

  const visitorOf = (c: Context, apiKey: string) =>
    createHmac("sha256", apiKey)
      .update(visitorKey(clientIp(c.req.header("x-forwarded-for"))))
      .digest("hex");

  async function chargeFor(row: SessionRow, t: number, apiKey: string): Promise<Charge> {
    if (row.chargedSeconds !== null)
      return { seconds: row.chargedSeconds, settled: true, active: false };
    const age = t - row.createdAt.getTime();
    const held: Charge = { seconds: row.reservedSeconds, settled: false, active: false };
    // No conversation id: the mint is in flight, or it crashed after handing out a credential.
    if (!row.conversationId) return { ...held, active: age < 60_000 };
    try {
      const res = await opts.fetch(
        `${opts.apiBase}/v1/convai/conversations/${encodeURIComponent(row.conversationId)}`,
        { headers: { "xi-api-key": apiKey } },
      );
      if (res.status === 404) {
        return age >= opts.unusedRefundMs
          ? { seconds: 0, settled: true, active: false }
          : { ...held, active: true };
      }
      if (!res.ok) return held;
      const data = (await res.json()) as {
        agent_id?: unknown;
        status?: unknown;
        metadata?: { call_duration_secs?: unknown };
      };
      if (data?.agent_id !== opts.agentId) return { ...held, settled: true };
      const duration = data?.metadata?.call_duration_secs;
      if (
        typeof data?.status === "string" &&
        SETTLED.has(data.status) &&
        typeof duration === "number"
      ) {
        return { seconds: Math.max(0, Math.ceil(duration)), settled: true, active: false };
      }
      return { ...held, active: true };
    } catch (err) {
      console.warn(`voice demo: conversation lookup failed: ${(err as Error).name}`);
      return held;
    }
  }

  async function allowanceOf(
    q: CoreDb,
    visitor: string,
    t: number,
    apiKey: string,
  ): Promise<Allowance> {
    const rows = await q
      .select()
      .from(voiceDemoSessions)
      .where(
        and(
          eq(voiceDemoSessions.visitor, visitor),
          gt(voiceDemoSessions.createdAt, new Date(t - opts.allowanceWindowMs)),
        ),
      )
      .orderBy(asc(voiceDemoSessions.createdAt));
    const charges = await Promise.all(rows.map((row) => chargeFor(row, t, apiKey)));
    for (const [i, row] of rows.entries()) {
      const charge = charges[i];
      if (charge?.settled && row.chargedSeconds === null) {
        await q
          .update(voiceDemoSessions)
          .set({ chargedSeconds: charge.seconds })
          .where(eq(voiceDemoSessions.id, row.id));
      }
    }
    const remaining = opts.allowanceSeconds - charges.reduce((sum, ch) => sum + ch.seconds, 0);
    const active = charges.some((ch) => ch.active);
    let retryAfter = 0;
    if (remaining < opts.minSeconds) {
      if (active) {
        retryAfter = ACTIVE_RETRY_SECONDS;
      } else {
        let freed = remaining;
        for (const [i, row] of rows.entries()) {
          freed += charges[i]?.seconds ?? 0;
          if (freed >= opts.minSeconds) {
            retryAfter = Math.max(
              1,
              Math.ceil((row.createdAt.getTime() + opts.allowanceWindowMs - t) / 1000),
            );
            break;
          }
        }
      }
    }
    return { remaining, retryAfter, active };
  }

  const allowanceBody = (a: Allowance) => ({
    remaining_seconds: Math.min(opts.allowanceSeconds, Math.max(0, a.remaining)),
    allowance_seconds: opts.allowanceSeconds,
    retry_after_seconds: a.retryAfter || null,
  });

  app.post("/v1/voice/demo/session", async (c) => {
    let body: { voice?: unknown; transport?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return fail(c, 400, "bad_request", "body must be JSON");
    }
    const voice = body?.voice;
    const transport = body?.transport ?? "webrtc";
    if (voice !== "female" && voice !== "male") {
      return fail(c, 400, "bad_request", 'voice must be "female" or "male"');
    }
    if (transport !== "webrtc" && transport !== "websocket") {
      return fail(c, 400, "bad_request", 'transport must be "webrtc" or "websocket"');
    }
    const { apiKey, agentId } = opts;
    if (!apiKey || !agentId) {
      return fail(c, 503, "not_configured", "voice demo is not configured");
    }

    const visitor = visitorOf(c, apiKey);
    const t = opts.now().getTime();
    const decision = await db.transaction(async (tx) => {
      const q = tx as unknown as CoreDb;
      await q.execute(sql`select pg_advisory_xact_lock(hashtext(${visitor}))`);
      const a = await allowanceOf(q, visitor, t, apiKey);
      if (a.remaining < opts.minSeconds) return { kind: "allowance" as const, a };
      const today = Math.floor(t / DAY_MS) * DAY_MS;
      const [day] = await q
        .select({ n: sql<number>`count(*)::int` })
        .from(voiceDemoSessions)
        .where(gte(voiceDemoSessions.createdAt, new Date(today)));
      if ((day?.n ?? 0) >= opts.daily) {
        return { kind: "busy" as const, wait: Math.max(1, Math.ceil((today + DAY_MS - t) / 1000)) };
      }
      const wait = burst(visitor, t);
      if (wait > 0) return { kind: "busy" as const, wait };
      const grant = Math.min(opts.maxSeconds, a.remaining);
      const [row] = await q
        .insert(voiceDemoSessions)
        .values({ visitor, reservedSeconds: grant, createdAt: new Date(t) })
        .returning({ id: voiceDemoSessions.id });
      return { kind: "granted" as const, id: row?.id ?? "", grant };
    });

    if (decision.kind === "allowance") {
      const { a } = decision;
      c.header("Retry-After", String(a.retryAfter || 1));
      return a.active
        ? fail(c, 429, "call_active", "your previous demo call is still open", allowanceBody(a))
        : fail(
            c,
            429,
            "allowance_used",
            "demo talk time used up, try again later",
            allowanceBody(a),
          );
    }
    if (decision.kind === "busy") {
      c.header("Retry-After", String(decision.wait));
      return fail(c, 429, "rate_limited", "too many demo sessions, try again later");
    }

    await db
      .delete(voiceDemoSessions)
      .where(lt(voiceDemoSessions.createdAt, new Date(t - 2 * opts.allowanceWindowMs)));

    const refund = () => db.delete(voiceDemoSessions).where(eq(voiceDemoSessions.id, decision.id));
    const path =
      transport === "webrtc"
        ? "/v1/convai/conversation/token"
        : "/v1/convai/conversation/get-signed-url";
    const query = `agent_id=${encodeURIComponent(agentId)}${transport === "websocket" ? "&include_conversation_id=true" : ""}`;
    let data: { token?: unknown; signed_url?: unknown; conversation_id?: unknown };
    try {
      const res = await opts.fetch(`${opts.apiBase}${path}?${query}`, {
        headers: { "xi-api-key": apiKey },
      });
      if (!res.ok) {
        console.warn(`voice demo: ElevenLabs ${path} returned ${res.status}`);
        await refund();
        return fail(c, 502, "upstream_error", "voice provider unavailable");
      }
      data = (await res.json()) as typeof data;
    } catch (err) {
      console.warn(`voice demo: ElevenLabs ${path} failed: ${(err as Error).name}`);
      await refund();
      return fail(c, 502, "upstream_error", "voice provider unavailable");
    }
    const credential = transport === "webrtc" ? data?.token : data?.signed_url;
    if (typeof credential !== "string" || !credential) {
      await refund();
      return fail(c, 502, "upstream_error", "voice provider unavailable");
    }
    // Without a conversation id the call cannot be measured, so it keeps its full reservation.
    if (typeof data?.conversation_id === "string" && data.conversation_id) {
      await db
        .update(voiceDemoSessions)
        .set({ conversationId: data.conversation_id })
        .where(eq(voiceDemoSessions.id, decision.id));
    }

    const { id, name } = opts.voices[voice];
    c.header("Cache-Control", "no-store");
    return c.json({
      ...(transport === "webrtc" ? { conversation_token: credential } : { signed_url: credential }),
      agent_id: agentId,
      voice_id: id,
      voice_name: name,
      max_seconds: decision.grant,
      allowance_seconds: opts.allowanceSeconds,
    });
  });
}
