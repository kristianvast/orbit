import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type { TokenResolver } from "./auth";
import {
  type ApplyOptions,
  createChangeApplier,
  type IncomingChange,
  MAX_CHANGES_PER_REQUEST,
} from "./changes";
import type { CoreDb } from "./db";
import { handleLlm, type LlmGatewayOptions } from "./llm";
import { type FetchLike, proxyShape } from "./shape";

export interface AppOptions {
  db: CoreDb;
  resolveToken: TokenResolver;
  electricUrl: string;
  electricSecret?: string;
  llm?: Partial<Omit<LlmGatewayOptions, "fetch" | "now">>;
  /** Used for upstream calls (Electric, LLM provider). Defaults to global fetch. */
  fetch?: FetchLike;
  now?: () => Date;
  apply?: ApplyOptions;
  version?: string;
}

type Env = { Variables: { farmId: string } };

export function createApp(options: AppOptions) {
  const app = new Hono<Env>();
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const applyChanges = createChangeApplier(options.db, { now, ...options.apply });
  const llmOptions: LlmGatewayOptions = {
    upstreamUrl: options.llm?.upstreamUrl,
    upstreamApiKey: options.llm?.upstreamApiKey,
    authHeader: options.llm?.authHeader ?? "authorization",
    defaultMonthlyTokenBudget: options.llm?.defaultMonthlyTokenBudget ?? 2_000_000,
    fetch: doFetch,
    now,
  };

  app.get("/healthz", async (c) => {
    try {
      await options.db.execute(sql`select 1`);
      return c.json({ ok: true, version: options.version ?? "dev" });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 503);
    }
  });

  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const farmId = match?.[1] ? await options.resolveToken(match[1].trim()) : null;
    if (!farmId) return c.json({ error: { code: "unauthorized", message: "invalid token" } }, 401);
    c.set("farmId", farmId);
    await next();
  });

  app.post("/v1/changes", async (c) => {
    let body: { changes?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "bad_request", message: "body must be JSON" } }, 400);
    }
    if (!Array.isArray(body.changes)) {
      return c.json({ error: { code: "bad_request", message: "changes must be an array" } }, 400);
    }
    if (body.changes.length > MAX_CHANGES_PER_REQUEST) {
      return c.json(
        { error: { code: "bad_request", message: `at most ${MAX_CHANGES_PER_REQUEST} changes` } },
        413,
      );
    }
    const changes = body.changes as IncomingChange[];
    if (!changes.every((ch) => ch && typeof ch === "object" && Number.isInteger(ch.seq))) {
      return c.json(
        { error: { code: "bad_request", message: "every change needs an integer seq" } },
        400,
      );
    }
    const results = await applyChanges(changes, c.get("farmId"));
    return c.json({ results });
  });

  app.get("/v1/shape", (c) =>
    proxyShape(c.req.raw, c.get("farmId"), {
      electricUrl: options.electricUrl,
      electricSecret: options.electricSecret,
      fetch: doFetch,
    }),
  );

  app.post("/v1/llm/*", (c) => {
    const path = c.req.path.slice("/v1/llm".length) || "/";
    return handleLlm(options.db, c.req.raw, c.get("farmId"), path, llmOptions);
  });

  return app;
}
