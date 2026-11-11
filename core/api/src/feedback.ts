import { createHash, timingSafeEqual } from "node:crypto";
import { and, desc, eq, getTableColumns, gt, lte, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { ADMIN_PAGE } from "./admin-page";
import { hashToken, memberRole, resolveSession, type SessionUser } from "./auth";
import { type CoreDb, feedback, feedbackRateEvents, submissions } from "./db";
import type { EmailMessage, Mailer } from "./mailer";
import { clientIp } from "./voice-demo";

export interface FeedbackOptions {
  readonly adminToken?: string;
  readonly notificationEmail?: string;
  readonly mailer: Mailer;
  readonly now: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEEDBACK_STATUSES = ["new", "read", "done"] as const;
const SUBMISSION_STATUSES = ["pending", "approved", "rejected"] as const;
const DAY_MS = 86_400_000;

class FeedbackError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 413 | 429,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return { ...value };
  throw new FeedbackError(400, "bad_request", "expected a JSON object");
}

async function body(c: Context) {
  try {
    return object(await c.req.json());
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new FeedbackError(400, "bad_request", "body must be JSON");
    }
    throw error;
  }
}

function string(value: unknown, field: string, min = 1, max = Number.POSITIVE_INFINITY) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new FeedbackError(400, "bad_request", `${field} has an invalid type or length`);
  }
  return value;
}

function optional(value: unknown, field: string, max = Number.POSITIVE_INFINITY) {
  return value === undefined ? null : string(value, field, 0, max);
}

function choice<T extends string>(value: unknown, field: string, choices: readonly T[]): T {
  const selected = choices.find((item) => item === value);
  if (selected === undefined) {
    throw new FeedbackError(400, "bad_request", `${field} must be ${choices.join(", ")}`);
  }
  return selected;
}

function id(c: Context) {
  const value = c.req.param("id") ?? "";
  if (!UUID.test(value)) throw new FeedbackError(400, "bad_request", "id must be a uuid");
  return value;
}

const bearer = (c: Context) =>
  /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "")?.[1]?.trim() ?? "";
const iso = (value: string) => new Date(value).toISOString();
const dated = <T extends { createdAt: string }>(row: T) => ({
  ...row,
  createdAt: iso(row.createdAt),
});
const reviewed = <T extends { createdAt: string; reviewedAt: string | null }>(row: T) => ({
  ...dated(row),
  reviewedAt: row.reviewedAt ? iso(row.reviewedAt) : null,
});
// The list projections never load file bodies from Postgres.
const { files: _files, ...submissionSummary } = getTableColumns(submissions);
const ownSummary = {
  id: submissions.id,
  kind: submissions.kind,
  name: submissions.name,
  title: submissions.title,
  status: submissions.status,
  reviewNote: submissions.reviewNote,
  createdAt: submissions.createdAt,
  reviewedAt: submissions.reviewedAt,
};

export function createFeedbackRoutes(db: CoreDb, options: FeedbackOptions) {
  const routes = new Hono();
  routes.onError((error, c) => {
    if (error instanceof FeedbackError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    throw error;
  });

  const session = (c: Context) => resolveSession(db, bearer(c), options.now());
  async function requiredSession(c: Context) {
    const user = await session(c);
    if (!user) throw new FeedbackError(401, "unauthorized", "a user session is required");
    return user;
  }
  async function farm(c: Context, user: SessionUser | null) {
    const wanted = c.req.header("x-orbit-farm")?.trim() ?? "";
    return user && UUID.test(wanted) && (await memberRole(db, wanted, user.id)) ? wanted : null;
  }
  async function notify(message: Omit<EmailMessage, "to">) {
    if (!options.notificationEmail) return;
    try {
      await options.mailer.send({ ...message, to: options.notificationEmail });
    } catch (error) {
      console.warn("feedback notification failed:", error instanceof Error ? error.message : error);
    }
  }

  routes.post("/v1/feedback", async (c) => {
    const user = await session(c);
    const input = await body(c);
    const kind = choice(input.kind, "kind", ["issue", "idea", "other"]);
    const message = string(input.message, "message", 1, 5000);
    const contactEmail = optional(input.contactEmail, "contactEmail");
    if (contactEmail !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
      throw new FeedbackError(400, "bad_request", "contactEmail must be an email address");
    }
    const appVersion = optional(input.appVersion, "appVersion");
    const os = optional(input.os, "os");
    const locale = optional(input.locale, "locale");
    const diagnostics = optional(input.diagnostics, "diagnostics", 20000);
    const farmId = await farm(c, user);
    const at = options.now();
    const identity = user
      ? `user:${user.id}`
      : `ip:${await hashToken(clientIp(c.req.header("x-forwarded-for")))}`;
    const row = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`feedback:${identity}`}))`);
      const cutoff = new Date(at.getTime() - DAY_MS).toISOString();
      await tx
        .delete(feedbackRateEvents)
        .where(
          and(eq(feedbackRateEvents.identity, identity), lte(feedbackRateEvents.createdAt, cutoff)),
        );
      const [count] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(feedbackRateEvents)
        .where(
          and(eq(feedbackRateEvents.identity, identity), gt(feedbackRateEvents.createdAt, cutoff)),
        );
      if ((count?.n ?? 0) >= 20) {
        throw new FeedbackError(429, "rate_limited", "at most 20 feedback messages per 24 hours");
      }
      await tx.insert(feedbackRateEvents).values({ identity, createdAt: at.toISOString() });
      const [inserted] = await tx
        .insert(feedback)
        .values({
          userId: user?.id ?? null,
          farmId,
          kind,
          message,
          contactEmail,
          appVersion,
          os,
          locale,
          diagnostics,
          createdAt: at.toISOString(),
        })
        .returning({ id: feedback.id });
      if (!inserted) throw new TypeError("feedback insert returned no row");
      return inserted;
    });
    await notify({
      template: "feedback_received",
      subject: `Orbit feedback: ${kind}`,
      text: `Kind: ${kind}\nWho: ${user?.email ?? contactEmail ?? "anonymous"}\nUser: ${user?.id ?? "anonymous"}\nContact: ${contactEmail ?? "-"}\nVersion: ${appVersion ?? "-"}\nOS: ${os ?? "-"}\n\n${message}`,
    });
    return c.json(row, 201);
  });

  routes.post("/v1/submissions", async (c) => {
    const user = await requiredSession(c);
    const input = await body(c);
    const kind = choice(input.kind, "kind", ["page", "connector", "skill"]);
    const name = string(input.name, "name");
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name)) {
      throw new FeedbackError(
        400,
        "bad_request",
        "name must be a lowercase slug of at most 48 characters",
      );
    }
    const title = string(input.title, "title", 1, 120);
    const description = string(input.description, "description", 1, 2000);
    const appVersion = optional(input.appVersion, "appVersion");
    if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 60) {
      throw new FeedbackError(400, "bad_request", "files must contain 1 to 60 files");
    }
    let bytes = 0;
    const files = input.files.map((value: unknown) => {
      const file = object(value);
      const path = string(file.path, "path", 1, 200);
      if (
        path.includes("..") ||
        !path.split("/").every((part) => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(part))
      ) {
        throw new FeedbackError(400, "bad_request", "path must be a safe relative path");
      }
      const content = string(file.content, "content", 0);
      const encoded = new TextEncoder().encode(content);
      if (
        new TextDecoder("utf-8", { ignoreBOM: true }).decode(encoded) !== content ||
        content.includes("\0")
      ) {
        throw new FeedbackError(
          400,
          "bad_request",
          "content must be UTF-8 text without null bytes",
        );
      }
      bytes += encoded.byteLength;
      if (bytes > 512 * 1024) {
        throw new FeedbackError(413, "too_large", "total file content must not exceed 512 KB");
      }
      return { path, content };
    });
    const [row] = await db
      .insert(submissions)
      .values({
        userId: user.id,
        farmId: await farm(c, user),
        kind,
        name,
        title,
        description,
        appVersion,
        files,
        bytes,
        createdAt: options.now().toISOString(),
      })
      .returning({ id: submissions.id, status: submissions.status });
    if (!row) throw new TypeError("submission insert returned no row");
    await notify({
      template: "submission_received",
      subject: `Orbit submission: ${name}`,
      text: `Kind: ${kind}\nName: ${name}\nTitle: ${title}\nWho: ${user.email} (${user.id})\nVersion: ${appVersion ?? "-"}\n\n${description}\n\nFiles:\n${files.map((file) => file.path).join("\n")}`,
    });
    return c.json(row, 201);
  });

  routes.get("/v1/submissions", async (c) => {
    const user = await requiredSession(c);
    const rows = await db
      .select(ownSummary)
      .from(submissions)
      .where(eq(submissions.userId, user.id))
      .orderBy(desc(submissions.createdAt), desc(submissions.id));
    return c.json({ submissions: rows.map(reviewed) });
  });

  routes.use("/v1/admin/*", async (c, next) => {
    if (!options.adminToken) throw new FeedbackError(404, "not_found", "not found");
    const digest = (value: string) => createHash("sha256").update(value).digest();
    if (!timingSafeEqual(digest(bearer(c)), digest(options.adminToken))) {
      throw new FeedbackError(401, "unauthorized", "invalid admin token");
    }
    c.header("Cache-Control", "no-store");
    await next();
  });
  routes.get("/admin", (c) => {
    if (!options.adminToken) throw new FeedbackError(404, "not_found", "not found");
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    return c.html(ADMIN_PAGE);
  });
  routes.get("/v1/admin/feedback", async (c) => {
    const status = c.req.query("status");
    const rows = await db
      .select()
      .from(feedback)
      .where(status ? eq(feedback.status, choice(status, "status", FEEDBACK_STATUSES)) : undefined)
      .orderBy(desc(feedback.createdAt), desc(feedback.id));
    return c.json({ feedback: rows.map(dated) });
  });
  routes.patch("/v1/admin/feedback/:id", async (c) => {
    const input = await body(c);
    const [row] = await db
      .update(feedback)
      .set({ status: choice(input.status, "status", FEEDBACK_STATUSES) })
      .where(eq(feedback.id, id(c)))
      .returning();
    if (!row) throw new FeedbackError(404, "not_found", "feedback not found");
    return c.json(dated(row));
  });
  routes.get("/v1/admin/submissions", async (c) => {
    const status = c.req.query("status");
    const rows = await db
      .select(submissionSummary)
      .from(submissions)
      .where(
        status ? eq(submissions.status, choice(status, "status", SUBMISSION_STATUSES)) : undefined,
      )
      .orderBy(desc(submissions.createdAt), desc(submissions.id));
    return c.json({ submissions: rows.map(reviewed) });
  });
  routes.get("/v1/admin/submissions/:id", async (c) => {
    const [row] = await db
      .select()
      .from(submissions)
      .where(eq(submissions.id, id(c)));
    if (!row) throw new FeedbackError(404, "not_found", "submission not found");
    return c.json(reviewed(row));
  });
  routes.patch("/v1/admin/submissions/:id", async (c) => {
    const input = await body(c);
    const status = choice(input.status, "status", SUBMISSION_STATUSES);
    const reviewNote = optional(input.reviewNote, "reviewNote");
    const [row] = await db
      .update(submissions)
      .set({
        status,
        ...(reviewNote === null ? {} : { reviewNote }),
        reviewedAt: status === "pending" ? null : options.now().toISOString(),
      })
      .where(eq(submissions.id, id(c)))
      .returning(submissionSummary);
    if (!row) throw new FeedbackError(404, "not_found", "submission not found");
    return c.json(reviewed(row));
  });
  return routes;
}
