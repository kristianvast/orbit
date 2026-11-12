import { type FarmRole, isFarmRole } from "@orbit/schema";
import type { Context } from "hono";
import type { SessionUser } from "./auth";
import type { EmailLinks, Mailer } from "./mailer";
import type { FetchLike } from "./shape";
export const INVITE_PREFIX = "orb_i_";
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const VERIFY_TTL_MS = 48 * 60 * 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;
export const EMAIL_TOKEN_PREFIX = { verify: "orb_v_", reset: "orb_r_" } as const;
export const RESEND_COOLDOWN_MS = 60 * 1000;
export const RESETS_PER_HOUR = 3;
export const TERMS_VERSION = "2026-11";
export const PAID_STATUSES = ["active", "trialing"];
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 256;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Postgres returns "2026-11-05 18:22:57.4+00"; clients (WebKit included) need ISO-8601.
export const iso = (pgTimestamp: string) => new Date(Date.parse(pgTimestamp)).toISOString();

export interface AccountOptions {
  now: () => Date;
  /** Failed logins allowed per email inside `windowMs` before login answers 429. */
  loginThrottle?: { maxFailures: number; windowMs: number };
  mailer: Mailer;
  links: EmailLinks;
  termsVersion?: string;
  googleClientIds?: readonly string[];
  fetch?: FetchLike;
}

export type AccountEnv = { Variables: { user: SessionUser; sessionToken: string } };
export type Ctx = Context<AccountEnv>;

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const fail = (c: Ctx, e: ApiError) =>
  c.json({ error: { code: e.code, message: e.message } }, e.status);

export async function body(c: Ctx): Promise<Record<string, unknown>> {
  const v: unknown = await c.req.json().catch(() => null);
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  throw new ApiError(400, "bad_request", "body must be a JSON object");
}

export function str(
  v: unknown,
  field: string,
  { optional = false, max = 200 } = {},
): string | null {
  if (v === undefined || v === null || v === "") {
    if (optional) return null;
    throw new ApiError(400, "bad_request", `${field} is required`);
  }
  if (typeof v !== "string" || v.length > max) {
    throw new ApiError(
      400,
      "bad_request",
      `${field} must be a string of at most ${max} characters`,
    );
  }
  return v.trim();
}

export function email(v: unknown): string {
  const e = (str(v, "email") as string).toLowerCase();
  if (!EMAIL.test(e)) throw new ApiError(400, "bad_request", "email is not a valid address");
  return e;
}

export function newPassword(v: unknown): string {
  if (typeof v !== "string" || v.length < PASSWORD_MIN || v.length > PASSWORD_MAX) {
    throw new ApiError(
      400,
      "weak_password",
      `password must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters`,
    );
  }
  return v;
}

export function role(v: unknown): FarmRole {
  if (!isFarmRole(v)) {
    throw new ApiError(400, "bad_request", "role must be owner, manager, worker or viewer");
  }
  return v;
}

export function usagePermission(b: Record<string, unknown>) {
  if (b.useFarmPlan !== undefined && typeof b.useFarmPlan !== "boolean")
    throw new ApiError(400, "bad_request", "useFarmPlan must be a boolean");
  if (
    b.monthlyTokenLimit !== undefined &&
    b.monthlyTokenLimit !== null &&
    (typeof b.monthlyTokenLimit !== "number" ||
      !Number.isSafeInteger(b.monthlyTokenLimit) ||
      b.monthlyTokenLimit < 0)
  )
    throw new ApiError(
      400,
      "bad_request",
      "monthlyTokenLimit must be a nonnegative integer or null",
    );
  return {
    ...(typeof b.useFarmPlan === "boolean" ? { useFarmPlan: b.useFarmPlan } : {}),
    ...(b.monthlyTokenLimit === null || typeof b.monthlyTokenLimit === "number"
      ? { monthlyTokenLimit: b.monthlyTokenLimit }
      : {}),
  };
}

export function farmIdParam(c: Ctx): string {
  const id = c.req.param("farmId") ?? "";
  if (!UUID.test(id)) throw new ApiError(400, "bad_request", "farmId must be a uuid");
  return id.toLowerCase();
}

// Verified against when the email is unknown so a missing account costs the same time as a wrong
// password (no account enumeration through login timing).
export const DUMMY_HASH = Bun.password.hash("orbit-dummy-password", { algorithm: "argon2id" });

export async function verifyPassword(password: string, hash: string | null | undefined) {
  const valid = await Bun.password.verify(
    password.slice(0, PASSWORD_MAX),
    hash ?? (await DUMMY_HASH),
  );
  return hash != null && valid;
}
