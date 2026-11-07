import { sql } from "drizzle-orm";
import { type Context, Hono, type Next } from "hono";
import { cors } from "hono/cors";
import { registerAccountRoutes } from "./accounts";
import { memberRole, type Principal, resolveSession, type TokenResolver } from "./auth";
import { registerBillingRoutes } from "./billing";
import {
  type ApplyOptions,
  createChangeApplier,
  type IncomingChange,
  MAX_CHANGES_PER_REQUEST,
} from "./changes";
import type { CoreDb } from "./db";
import { handleLlm, type LlmGatewayOptions } from "./llm";
import { createLogMailer, type EmailLinks, type Mailer } from "./mailer";
import { type FetchLike, proxyShape } from "./shape";
import type { StripeOptions } from "./stripe";

export interface AppOptions {
  db: CoreDb;
  resolveToken: TokenResolver;
  electricUrl: string;
  electricSecret?: string;
  llm?: Partial<Omit<LlmGatewayOptions, "fetch" | "now">>;
  loginThrottle?: { maxFailures: number; windowMs: number };
  /** Used for upstream calls (Electric, LLM provider). Defaults to global fetch. */
  fetch?: FetchLike;
  now?: () => Date;
  apply?: ApplyOptions;
  version?: string;
  billing?: Partial<Omit<StripeOptions, "fetch" | "now" | "mailer" | "links">>;
  corsOrigins?: readonly string[];
  /** Defaults to printing messages (development and tests). */
  mailer?: Mailer;
  links?: Partial<EmailLinks>;
  termsVersion?: string;
}

export const DEFAULT_LINKS: EmailLinks = {
  siteUrl: "http://localhost:3000",
  downloadUrl: "https://github.com/kristianvast/orbit/releases/latest",
};

/** Header naming the farm a user session acts on (a session can belong to several farms). */
export const FARM_HEADER = "x-orbit-farm";

type Env = { Variables: { principal: Principal } };

export function createApp(options: AppOptions) {
  const app = new Hono<Env>();
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const applyChanges = createChangeApplier(options.db, { now, ...options.apply });
  const mailer = options.mailer ?? createLogMailer();
  const links: EmailLinks = { ...DEFAULT_LINKS, ...options.links };
  const llmOptions: LlmGatewayOptions = {
    upstreamUrl: options.llm?.upstreamUrl,
    upstreamApiKey: options.llm?.upstreamApiKey,
    authHeader: options.llm?.authHeader ?? "authorization",
    defaultMonthlyTokenBudget: options.llm?.defaultMonthlyTokenBudget ?? 2_000_000,
    defaultModel: options.llm?.defaultModel,
    accessToken: options.llm?.accessToken,
    stripPrefix: options.llm?.stripPrefix,
    fetch: doFetch,
    now,
  };
  const websiteCors = cors({
    origin: [...(options.corsOrigins ?? ["http://localhost:3000"])],
    allowHeaders: ["authorization", "content-type", "x-orbit-farm"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  for (const path of [
    "/v1/auth/*",
    "/v1/me",
    "/v1/me/*",
    "/v1/farms",
    "/v1/farms/*",
    "/v1/billing/*",
  ])
    app.use(path, websiteCors);

  const health = async (c: Context<Env>) => {
    try {
      await options.db.execute(sql`select 1`);
      return c.json({ ok: true, version: options.version ?? "dev" });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 503);
    }
  };
  app.get("/healthz", health);
  // Cloud Run's front end reserves paths ending in "z", so /healthz never reaches the service there.
  app.get("/health", health);

  registerAccountRoutes(app as unknown as Hono, options.db, {
    now,
    loginThrottle: options.loginThrottle,
    mailer,
    links,
    termsVersion: options.termsVersion,
  });

  // Farm-scoped routes accept a user session (+ x-orbit-farm, membership required) or a legacy
  // per-farm api token, which keeps full (owner) rights for installs set up before accounts.
  const farmAuth = async (c: Context<Env>, next: Next) => {
    const match = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
    const token = match?.[1]?.trim() ?? "";
    const wanted = c.req.header(FARM_HEADER)?.trim().toLowerCase() || null;
    const user = token ? await resolveSession(options.db, token, now()) : null;
    if (user) {
      if (!wanted) {
        return c.json(
          { error: { code: "bad_request", message: `${FARM_HEADER} header is required` } },
          400,
        );
      }
      const role = /^[0-9a-f-]{36}$/.test(wanted)
        ? await memberRole(options.db, wanted, user.id)
        : null;
      if (!role) {
        return c.json(
          { error: { code: "forbidden", message: "you are not a member of this farm" } },
          403,
        );
      }
      c.set("principal", { farmId: wanted, role, userId: user.id });
      return next();
    }
    const farmId = token ? await options.resolveToken(token) : null;
    if (!farmId) return c.json({ error: { code: "unauthorized", message: "invalid token" } }, 401);
    if (wanted && wanted !== farmId) {
      return c.json({ error: { code: "forbidden", message: "token is for another farm" } }, 403);
    }
    c.set("principal", { farmId, role: "owner", userId: null });
    return next();
  };
  for (const path of ["/v1/billing/checkout", "/v1/billing/portal", "/v1/billing/status"]) {
    app.use(path, farmAuth);
  }
  registerBillingRoutes(app, options.db, {
    ...options.billing,
    mailer,
    links,
    fetch: doFetch,
    now,
  });

  app.post("/v1/changes", farmAuth, async (c) => {
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
    const { farmId, role } = c.get("principal");
    const results = await applyChanges(changes, farmId, role);
    return c.json({ results });
  });

  app.get("/v1/shape", farmAuth, (c) =>
    proxyShape(c.req.raw, c.get("principal").farmId, {
      electricUrl: options.electricUrl,
      electricSecret: options.electricSecret,
      fetch: doFetch,
    }),
  );

  app.post("/v1/llm/*", farmAuth, (c) => {
    const path = c.req.path.slice("/v1/llm".length) || "/";
    const principal = c.get("principal");
    return handleLlm(options.db, c.req.raw, principal.farmId, path, {
      ...llmOptions,
      sessionPrincipal: principal.userId !== null,
    });
  });

  return app;
}
