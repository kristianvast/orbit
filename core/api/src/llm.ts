// POST /v1/llm/*: metered LLM gateway. Forwards the request to the configured upstream provider
// with Core's API key, refuses farms over their monthly token budget, and records one llm_usage
// row per request (token counts parsed from JSON or SSE responses). Billing is not built yet.
import { and, eq, gte, sql } from "drizzle-orm";
import { type CoreDb, farmBudgets, llmUsage } from "./db";
import type { FetchLike } from "./shape";

export interface LlmGatewayOptions {
  /** e.g. https://api.openai.com or https://api.anthropic.com (no trailing slash needed). */
  upstreamUrl?: string;
  upstreamApiKey?: string;
  /** "authorization" sends `Bearer <key>`; "x-api-key" sends the raw key (Anthropic). */
  authHeader: "authorization" | "x-api-key";
  defaultMonthlyTokenBudget: number;
  /** Upstream model used when Orion asks for the generic "orbit-default" model. */
  defaultModel?: string;
  fetch: FetchLike;
  now: () => Date;
}

export const ORBIT_DEFAULT_MODEL = "orbit-default";

const FORWARDED_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta"];

export interface Usage {
  input: number;
  output: number;
}

/** Reads token usage from an OpenAI- or Anthropic-style response object or stream event. */
export function usageFrom(event: unknown, into: Usage): void {
  if (!event || typeof event !== "object") return;
  const e = event as Record<string, Record<string, unknown> | undefined>;
  const u = (e.usage ?? e.message?.usage ?? e.response?.usage) as
    | Record<string, unknown>
    | undefined;
  if (!u) return;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  into.input = Math.max(into.input, num(u.prompt_tokens), num(u.input_tokens));
  into.output = Math.max(into.output, num(u.completion_tokens), num(u.output_tokens));
}

export function monthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export async function usedThisMonth(db: CoreDb, farmId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ used: sql<string | number | null>`coalesce(sum(${llmUsage.totalTokens}), 0)` })
    .from(llmUsage)
    .where(and(eq(llmUsage.farmId, farmId), gte(llmUsage.createdAt, monthStart(now))));
  return Number(row?.used ?? 0);
}

async function budgetFor(db: CoreDb, farmId: string, fallback: number): Promise<number> {
  const [row] = await db
    .select({ budget: farmBudgets.monthlyTokenBudget })
    .from(farmBudgets)
    .where(eq(farmBudgets.farmId, farmId));
  return row?.budget ?? fallback;
}

function sseUsageTap(
  onDone: (usage: Usage) => Promise<void>,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const usage: Usage = { input: 0, output: 0 };
  let buffer = "";
  const scan = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      usageFrom(JSON.parse(data), usage);
    } catch {
      // Not every data line is JSON (provider keep-alives); those carry no usage.
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) scan(line);
    },
    async flush() {
      scan(buffer);
      await onDone(usage);
    },
  });
}

export async function handleLlm(
  db: CoreDb,
  request: Request,
  farmId: string,
  path: string,
  options: LlmGatewayOptions,
): Promise<Response> {
  if (!options.upstreamUrl || !options.upstreamApiKey) {
    return Response.json(
      { error: { code: "not_configured", message: "LLM gateway is not configured" } },
      { status: 503 },
    );
  }
  const now = options.now();
  const [used, budget] = await Promise.all([
    usedThisMonth(db, farmId, now),
    budgetFor(db, farmId, options.defaultMonthlyTokenBudget),
  ]);
  if (used >= budget) {
    return Response.json(
      { error: { code: "budget_exceeded", message: "Monthly token budget used up", used, budget } },
      { status: 429 },
    );
  }

  const raw = await request.text();
  let body = raw;
  let model: string | null = null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    let changed = false;
    if (parsed.model === ORBIT_DEFAULT_MODEL && options.defaultModel) {
      parsed.model = options.defaultModel;
      changed = true;
    }
    model = typeof parsed.model === "string" ? parsed.model : null;
    if (parsed.stream === true && path.endsWith("/chat/completions")) {
      parsed.stream_options = { ...(parsed.stream_options as object), include_usage: true };
      changed = true;
    }
    if (changed) body = JSON.stringify(parsed);
  } catch {
    // Non-JSON bodies are forwarded untouched.
  }

  const headers = new Headers();
  for (const h of FORWARDED_HEADERS) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (options.authHeader === "x-api-key") headers.set("x-api-key", options.upstreamApiKey);
  else headers.set("authorization", `Bearer ${options.upstreamApiKey}`);

  const record = async (status: number, usage: Usage) => {
    await db.insert(llmUsage).values({
      farmId,
      model,
      path,
      status,
      inputTokens: usage.input,
      outputTokens: usage.output,
      totalTokens: usage.input + usage.output,
      createdAt: options.now().toISOString(),
    });
  };

  let upstream: Response;
  try {
    upstream = await options.fetch(`${options.upstreamUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers,
      body,
      signal: request.signal,
    });
  } catch (err) {
    return Response.json(
      { error: { code: "upstream_unreachable", message: (err as Error).message } },
      { status: 502 },
    );
  }

  const outHeaders = new Headers(upstream.headers);
  outHeaders.delete("content-encoding");
  outHeaders.delete("content-length");
  const isStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  if (isStream && upstream.body) {
    const tapped = upstream.body.pipeThrough(sseUsageTap((u) => record(upstream.status, u)));
    return new Response(tapped, { status: upstream.status, headers: outHeaders });
  }
  const text = await upstream.text();
  const usage: Usage = { input: 0, output: 0 };
  try {
    usageFrom(JSON.parse(text), usage);
  } catch {
    // Error pages from the upstream may not be JSON; they are recorded with zero tokens.
  }
  await record(upstream.status, usage);
  return new Response(text, { status: upstream.status, headers: outHeaders });
}
