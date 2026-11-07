// Accounts, farm membership and invites:
//   POST /v1/auth/register | /v1/auth/login | /v1/auth/logout, GET /v1/me, POST /v1/farms,
//   GET|PATCH|DELETE /v1/farms/:farmId/members[/:userId],
//   GET|POST|DELETE /v1/farms/:farmId/invites[/:inviteId], POST /v1/invites/accept.
// Passwords are argon2id hashes (Bun.password); session tokens and invite codes are stored only as
// SHA-256 hashes. Invites are single-use, expire, and only the invited (verified) email can accept.
// Lifecycle: POST /v1/auth/verify-email | /v1/auth/resend-verification | /v1/auth/password-reset
//   [/confirm], POST /v1/me/password, GET|DELETE /v1/me/sessions[/:id], GET /v1/me/export,
//   DELETE /v1/me. Email links and reset requests never reveal whether an address has an account.
import {
  assignableRoles,
  canManageMember,
  canManageMembers,
  createHlc,
  type FarmRole,
  isFarmRole,
  pg,
} from "@orbit/schema";
import { and, asc, desc, eq, gt, gte, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import {
  createSession,
  hashToken,
  memberRole,
  randomToken,
  resolveSession,
  type SessionUser,
} from "./auth";
import {
  apiTokens,
  billingCustomers,
  type CoreDb,
  emailTokens,
  farmBudgets,
  farmInvites,
  farmMembers,
  farmSubscriptions,
  hardwareOrders,
  llmUsage,
  loginFailures,
  userSessions,
  users,
  voiceUsage,
} from "./db";
import { type EmailLinks, type EmailMessage, emails, type Mailer } from "./mailer";

export const INVITE_PREFIX = "orb_i_";
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const VERIFY_TTL_MS = 48 * 60 * 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;
const EMAIL_TOKEN_PREFIX = { verify: "orb_v_", reset: "orb_r_" } as const;
const RESEND_COOLDOWN_MS = 60 * 1000;
const RESETS_PER_HOUR = 3;
export const TERMS_VERSION = "2026-11";
const PAID_STATUSES = ["active", "trialing"];
export const PASSWORD_MIN = 10;
const PASSWORD_MAX = 256;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Postgres returns "2026-11-05 18:22:57.4+00"; clients (WebKit included) need ISO-8601.
const iso = (pgTimestamp: string) => new Date(Date.parse(pgTimestamp)).toISOString();

export interface AccountOptions {
  now: () => Date;
  /** Failed logins allowed per email inside `windowMs` before login answers 429. */
  loginThrottle?: { maxFailures: number; windowMs: number };
  mailer: Mailer;
  links: EmailLinks;
  termsVersion?: string;
}

type AccountEnv = { Variables: { user: SessionUser; sessionToken: string } };
type Ctx = Context<AccountEnv>;

class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const fail = (c: Ctx, e: ApiError) =>
  c.json({ error: { code: e.code, message: e.message } }, e.status);

async function body(c: Ctx): Promise<Record<string, unknown>> {
  const v: unknown = await c.req.json().catch(() => null);
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  throw new ApiError(400, "bad_request", "body must be a JSON object");
}

function str(v: unknown, field: string, { optional = false, max = 200 } = {}): string | null {
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

function email(v: unknown): string {
  const e = (str(v, "email") as string).toLowerCase();
  if (!EMAIL.test(e)) throw new ApiError(400, "bad_request", "email is not a valid address");
  return e;
}

function newPassword(v: unknown): string {
  if (typeof v !== "string" || v.length < PASSWORD_MIN || v.length > PASSWORD_MAX) {
    throw new ApiError(
      400,
      "weak_password",
      `password must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters`,
    );
  }
  return v;
}

function role(v: unknown): FarmRole {
  if (!isFarmRole(v)) {
    throw new ApiError(400, "bad_request", "role must be owner, manager, worker or viewer");
  }
  return v;
}

function farmIdParam(c: Ctx): string {
  const id = c.req.param("farmId") ?? "";
  if (!UUID.test(id)) throw new ApiError(400, "bad_request", "farmId must be a uuid");
  return id.toLowerCase();
}

// Verified against when the email is unknown so a missing account costs the same time as a wrong
// password (no account enumeration through login timing).
const DUMMY_HASH = Bun.password.hash("orbit-dummy-password", { algorithm: "argon2id" });

export function registerAccountRoutes(app: Hono, db: CoreDb, options: AccountOptions) {
  const { now, mailer, links } = options;
  const termsVersion = options.termsVersion ?? TERMS_VERSION;
  const throttle = options.loginThrottle ?? { maxFailures: 10, windowMs: 15 * 60 * 1000 };
  const routes = app as unknown as Hono<AccountEnv>;

  const userView = (u: SessionUser) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    emailVerified: u.emailVerified,
  });

  // Email delivery must not undo the account change that triggered it; failures are logged loudly.
  const deliver = async (message: EmailMessage) => {
    try {
      await mailer.send(message);
    } catch (error) {
      console.error(
        `mail ${message.template} to ${message.to} failed: ${(error as Error).message}`,
      );
    }
  };

  const issueEmailToken = async (
    userId: string,
    address: string,
    purpose: "verify" | "reset",
  ): Promise<string> => {
    const code = randomToken(EMAIL_TOKEN_PREFIX[purpose]);
    const t = now().getTime();
    await db.insert(emailTokens).values({
      tokenHash: await hashToken(code),
      userId,
      purpose,
      email: address,
      createdAt: new Date(t).toISOString(),
      expiresAt: new Date(t + (purpose === "verify" ? VERIFY_TTL_MS : RESET_TTL_MS)).toISOString(),
    });
    return code;
  };

  const tokensSince = async (userId: string, purpose: "verify" | "reset", sinceMs: number) => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(emailTokens)
      .where(
        and(
          eq(emailTokens.userId, userId),
          eq(emailTokens.purpose, purpose),
          gte(emailTokens.createdAt, new Date(sinceMs).toISOString()),
        ),
      );
    return Number(row?.n ?? 0);
  };

  const requireSession = async (c: Ctx, next: () => Promise<void>) => {
    const match = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
    const token = match?.[1]?.trim() ?? "";
    const user = token ? await resolveSession(db, token, now()) : null;
    if (!user) return fail(c, new ApiError(401, "unauthorized", "sign in first"));
    c.set("user", user);
    c.set("sessionToken", token);
    await next();
  };

  const actorRole = async (c: Ctx, farmId: string): Promise<FarmRole> => {
    const r = await memberRole(db, farmId, c.get("user").id);
    if (!r) throw new ApiError(403, "forbidden", "you are not a member of this farm");
    return r;
  };

  const ownerCount = async (farmId: string) => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(farmMembers)
      .where(and(eq(farmMembers.farmId, farmId), eq(farmMembers.role, "owner")));
    return Number(row?.n ?? 0);
  };

  const wrap =
    (handler: (c: Ctx) => Promise<Response>) =>
    async (c: Ctx): Promise<Response> => {
      try {
        return await handler(c);
      } catch (err) {
        if (err instanceof ApiError) return fail(c, err);
        throw err;
      }
    };

  routes.post(
    "/v1/auth/register",
    wrap(async (c) => {
      const b = await body(c);
      const address = email(b.email);
      const password = newPassword(b.password);
      if (b.acceptTerms !== true) {
        throw new ApiError(400, "terms_required", "accept the terms of service to sign up");
      }
      const name = str(b.name, "name", { optional: true });
      const deviceName = str(b.deviceName, "deviceName", { optional: true });
      const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
      const ts = now().toISOString();
      const [created] = await db
        .insert(users)
        .values({
          email: address,
          name,
          passwordHash,
          termsVersion,
          termsAcceptedAt: ts,
          dataConsentAt: b.dataConsent === true ? ts : null,
        })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id, email: users.email, name: users.name });
      if (!created) throw new ApiError(409, "email_taken", "an account with this email exists");
      const session = await createSession(db, created.id, deviceName, now());
      await deliver(
        emails.verify(links, address, await issueEmailToken(created.id, address, "verify")),
      );
      return c.json({ user: userView({ ...created, emailVerified: false }), session }, 201);
    }),
  );

  routes.post(
    "/v1/auth/login",
    wrap(async (c) => {
      const b = await body(c);
      const address = email(b.email);
      const password = typeof b.password === "string" ? b.password : "";
      const t = now().getTime();
      const windowStart = new Date(t - throttle.windowMs).toISOString();
      const [recent] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(loginFailures)
        .where(and(eq(loginFailures.email, address), gte(loginFailures.at, windowStart)));
      if (Number(recent?.n ?? 0) >= throttle.maxFailures) {
        throw new ApiError(429, "too_many_attempts", "too many failed sign-ins; try again later");
      }
      const [user] = await db.select().from(users).where(eq(users.email, address)).limit(1);
      const ok = await Bun.password.verify(
        password.slice(0, PASSWORD_MAX),
        user?.passwordHash ?? (await DUMMY_HASH),
      );
      if (!user || !ok) {
        await db
          .delete(loginFailures)
          .where(and(eq(loginFailures.email, address), lt(loginFailures.at, windowStart)));
        await db.insert(loginFailures).values({ email: address, at: new Date(t).toISOString() });
        throw new ApiError(401, "invalid_credentials", "wrong email or password");
      }
      await db.delete(loginFailures).where(eq(loginFailures.email, address));
      const deviceName = str(b.deviceName, "deviceName", { optional: true });
      const session = await createSession(db, user.id, deviceName, now());
      return c.json({
        user: userView({ ...user, emailVerified: user.emailVerifiedAt !== null }),
        session,
      });
    }),
  );

  routes.post("/v1/auth/logout", requireSession, async (c) => {
    await db
      .update(userSessions)
      .set({ revokedAt: now().toISOString() })
      .where(eq(userSessions.tokenHash, await hashToken(c.get("sessionToken"))));
    return c.body(null, 204);
  });

  routes.get("/v1/me", requireSession, async (c) => {
    const user = c.get("user");
    const rows = await db
      .select({
        farmId: farmMembers.farmId,
        role: farmMembers.role,
        name: pg.farms.name,
        plan: farmSubscriptions.plan,
        status: farmSubscriptions.status,
      })
      .from(farmMembers)
      .leftJoin(pg.farms, eq(pg.farms.id, farmMembers.farmId))
      .leftJoin(farmSubscriptions, eq(farmSubscriptions.farmId, farmMembers.farmId))
      .where(eq(farmMembers.userId, user.id))
      .orderBy(asc(farmMembers.createdAt));
    const farms = rows.map(({ status, plan, ...farm }) => ({
      ...farm,
      plan: plan && status && PAID_STATUSES.includes(status) ? plan : "free",
    }));
    return c.json({ user: userView(user), farms });
  });

  routes.post(
    "/v1/auth/verify-email",
    wrap(async (c) => {
      const code = str((await body(c)).token, "token", { max: 100 }) as string;
      const tokenHash = await hashToken(code);
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(emailTokens)
          .where(and(eq(emailTokens.tokenHash, tokenHash), eq(emailTokens.purpose, "verify")))
          .for("update");
        const [user] = row ? await tx.select().from(users).where(eq(users.id, row.userId)) : [];
        if (
          !row ||
          !user ||
          row.usedAt ||
          Date.parse(row.expiresAt) <= now().getTime() ||
          user.email !== row.email
        ) {
          throw new ApiError(410, "link_invalid", "this link is invalid or has expired");
        }
        const ts = now().toISOString();
        await tx
          .update(emailTokens)
          .set({ usedAt: ts })
          .where(eq(emailTokens.tokenHash, tokenHash));
        await tx
          .update(users)
          .set({ emailVerifiedAt: user.emailVerifiedAt ?? ts })
          .where(eq(users.id, user.id));
        return c.json({ email: user.email, emailVerified: true });
      });
    }),
  );

  routes.post(
    "/v1/auth/resend-verification",
    requireSession,
    wrap(async (c) => {
      const user = c.get("user");
      if (user.emailVerified) throw new ApiError(409, "already_verified", "email already verified");
      if ((await tokensSince(user.id, "verify", now().getTime() - RESEND_COOLDOWN_MS)) > 0) {
        throw new ApiError(429, "too_many_attempts", "wait a minute before asking again");
      }
      await deliver(
        emails.verify(links, user.email, await issueEmailToken(user.id, user.email, "verify")),
      );
      return c.json({ sent: true }, 202);
    }),
  );

  routes.post(
    "/v1/auth/password-reset",
    wrap(async (c) => {
      const address = email((await body(c)).email);
      const [user] = await db.select().from(users).where(eq(users.email, address)).limit(1);
      if (
        user &&
        (await tokensSince(user.id, "reset", now().getTime() - 60 * 60 * 1000)) < RESETS_PER_HOUR
      ) {
        const code = await issueEmailToken(user.id, address, "reset");
        // Not awaited, so the answer takes the same time whether or not the account exists.
        void deliver(emails.reset(links, address, code));
      }
      return c.json({ sent: true }, 202);
    }),
  );

  routes.post(
    "/v1/auth/password-reset/confirm",
    wrap(async (c) => {
      const b = await body(c);
      const code = str(b.token, "token", { max: 100 }) as string;
      const password = newPassword(b.password);
      const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
      const tokenHash = await hashToken(code);
      const address = await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(emailTokens)
          .where(and(eq(emailTokens.tokenHash, tokenHash), eq(emailTokens.purpose, "reset")))
          .for("update");
        const [user] = row ? await tx.select().from(users).where(eq(users.id, row.userId)) : [];
        if (
          !row ||
          !user ||
          row.usedAt ||
          Date.parse(row.expiresAt) <= now().getTime() ||
          user.email !== row.email
        ) {
          throw new ApiError(410, "link_invalid", "this link is invalid or has expired");
        }
        const ts = now().toISOString();
        await tx
          .update(users)
          .set({ passwordHash, emailVerifiedAt: user.emailVerifiedAt ?? ts })
          .where(eq(users.id, user.id));
        await tx
          .update(emailTokens)
          .set({ usedAt: ts })
          .where(
            and(
              eq(emailTokens.userId, user.id),
              eq(emailTokens.purpose, "reset"),
              isNull(emailTokens.usedAt),
            ),
          );
        await tx
          .update(userSessions)
          .set({ revokedAt: ts })
          .where(and(eq(userSessions.userId, user.id), isNull(userSessions.revokedAt)));
        await tx.delete(loginFailures).where(eq(loginFailures.email, user.email));
        return user.email;
      });
      await deliver(emails.passwordChanged(address));
      return c.body(null, 204);
    }),
  );

  routes.post(
    "/v1/me/password",
    requireSession,
    wrap(async (c) => {
      const b = await body(c);
      const user = c.get("user");
      const [row] = await db.select().from(users).where(eq(users.id, user.id));
      const current = typeof b.currentPassword === "string" ? b.currentPassword : "";
      if (!row || !(await Bun.password.verify(current.slice(0, PASSWORD_MAX), row.passwordHash))) {
        throw new ApiError(401, "invalid_credentials", "current password is wrong");
      }
      const passwordHash = await Bun.password.hash(newPassword(b.newPassword), {
        algorithm: "argon2id",
      });
      const currentHash = await hashToken(c.get("sessionToken"));
      await db.transaction(async (tx) => {
        await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
        await tx
          .update(userSessions)
          .set({ revokedAt: now().toISOString() })
          .where(
            and(
              eq(userSessions.userId, user.id),
              ne(userSessions.tokenHash, currentHash),
              isNull(userSessions.revokedAt),
            ),
          );
      });
      await deliver(emails.passwordChanged(user.email));
      return c.body(null, 204);
    }),
  );

  routes.get("/v1/me/sessions", requireSession, async (c) => {
    const currentHash = await hashToken(c.get("sessionToken"));
    const rows = await db
      .select()
      .from(userSessions)
      .where(
        and(
          eq(userSessions.userId, c.get("user").id),
          isNull(userSessions.revokedAt),
          gt(userSessions.expiresAt, now().toISOString()),
        ),
      )
      .orderBy(desc(userSessions.createdAt));
    return c.json({
      sessions: rows.map((s) => ({
        id: s.id,
        deviceName: s.deviceName,
        createdAt: iso(s.createdAt),
        expiresAt: iso(s.expiresAt),
        current: s.tokenHash === currentHash,
      })),
    });
  });

  routes.delete(
    "/v1/me/sessions/:sessionId",
    requireSession,
    wrap(async (c) => {
      const sessionId = c.req.param("sessionId") ?? "";
      const revoked = UUID.test(sessionId)
        ? await db
            .update(userSessions)
            .set({ revokedAt: now().toISOString() })
            .where(
              and(
                eq(userSessions.id, sessionId),
                eq(userSessions.userId, c.get("user").id),
                isNull(userSessions.revokedAt),
              ),
            )
            .returning({ id: userSessions.id })
        : [];
      if (revoked.length === 0) throw new ApiError(404, "not_found", "no such session");
      return c.body(null, 204);
    }),
  );

  routes.get("/v1/me/export", requireSession, async (c) => {
    const user = c.get("user");
    const [profile] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        createdAt: users.createdAt,
        emailVerifiedAt: users.emailVerifiedAt,
        termsVersion: users.termsVersion,
        termsAcceptedAt: users.termsAcceptedAt,
        dataConsentAt: users.dataConsentAt,
      })
      .from(users)
      .where(eq(users.id, user.id));
    const [sessions, memberships, invitesSent, orders] = await Promise.all([
      db
        .select({
          id: userSessions.id,
          deviceName: userSessions.deviceName,
          createdAt: userSessions.createdAt,
          expiresAt: userSessions.expiresAt,
          revokedAt: userSessions.revokedAt,
        })
        .from(userSessions)
        .where(eq(userSessions.userId, user.id)),
      db
        .select({
          farmId: farmMembers.farmId,
          role: farmMembers.role,
          createdAt: farmMembers.createdAt,
          plan: farmSubscriptions.plan,
          status: farmSubscriptions.status,
          interval: farmSubscriptions.interval,
        })
        .from(farmMembers)
        .leftJoin(farmSubscriptions, eq(farmSubscriptions.farmId, farmMembers.farmId))
        .where(eq(farmMembers.userId, user.id)),
      db
        .select({
          farmId: farmInvites.farmId,
          email: farmInvites.email,
          role: farmInvites.role,
          createdAt: farmInvites.createdAt,
          acceptedAt: farmInvites.acceptedAt,
        })
        .from(farmInvites)
        .where(eq(farmInvites.invitedBy, user.id)),
      db
        .select()
        .from(hardwareOrders)
        .where(or(eq(hardwareOrders.userId, user.id), eq(hardwareOrders.email, user.email))),
    ]);
    c.header("content-disposition", `attachment; filename="pecorva-account-${user.id}.json"`);
    return c.json({
      exportedAt: now().toISOString(),
      profile,
      sessions,
      memberships,
      invitesSent,
      hardwareOrders: orders,
    });
  });

  /**
   * Deletes the account. Farms the caller owns alone and shares with nobody are wiped from the
   * cloud (local Orbit copies stay on the farm PC); shared farms need another owner first, and a
   * running paid plan must be cancelled first. Invoices and order records stay in Stripe and
   * hardware_orders for bookkeeping, unlinked from the account.
   */
  routes.delete(
    "/v1/me",
    requireSession,
    wrap(async (c) => {
      const b = await body(c);
      const user = c.get("user");
      const [row] = await db.select().from(users).where(eq(users.id, user.id));
      const password = typeof b.password === "string" ? b.password : "";
      if (!row || !(await Bun.password.verify(password.slice(0, PASSWORD_MAX), row.passwordHash))) {
        throw new ApiError(401, "invalid_credentials", "password is wrong");
      }
      await db.transaction(async (tx) => {
        const owned = await tx
          .select({ farmId: farmMembers.farmId })
          .from(farmMembers)
          .where(and(eq(farmMembers.userId, user.id), eq(farmMembers.role, "owner")));
        const wipe: string[] = [];
        for (const { farmId } of owned) {
          const others = (
            await tx
              .select({ userId: farmMembers.userId, role: farmMembers.role })
              .from(farmMembers)
              .where(eq(farmMembers.farmId, farmId))
          ).filter((m) => m.userId !== user.id);
          if (others.some((m) => m.role === "owner")) continue;
          if (others.length > 0) {
            throw new ApiError(
              409,
              "transfer_ownership",
              "make another member an owner of your shared farm first",
            );
          }
          const [sub] = await tx
            .select()
            .from(farmSubscriptions)
            .where(eq(farmSubscriptions.farmId, farmId));
          if (
            sub &&
            ["active", "trialing", "past_due", "unpaid"].includes(sub.status) &&
            !sub.cancelAtPeriodEnd
          ) {
            throw new ApiError(409, "subscription_active", "cancel your plan before deleting");
          }
          wipe.push(farmId);
        }
        for (const farmId of wipe) {
          await tx.delete(pg.cameraLayouts).where(eq(pg.cameraLayouts.farmId, farmId));
          await tx.delete(pg.cameras).where(eq(pg.cameras.farmId, farmId));
          await tx.delete(pg.observations).where(eq(pg.observations.farmId, farmId));
          await tx.delete(pg.connectors).where(eq(pg.connectors.farmId, farmId));
          await tx.delete(pg.deviceBindings).where(eq(pg.deviceBindings.farmId, farmId));
          await tx.delete(pg.devices).where(eq(pg.devices.farmId, farmId));
          await tx.delete(pg.animals).where(eq(pg.animals.farmId, farmId));
          await tx.delete(pg.farms).where(eq(pg.farms.id, farmId));
          await tx.delete(farmInvites).where(eq(farmInvites.farmId, farmId));
          await tx.delete(apiTokens).where(eq(apiTokens.farmId, farmId));
        }
        await tx
          .update(hardwareOrders)
          .set({ userId: null })
          .where(eq(hardwareOrders.userId, user.id));
        await tx.delete(loginFailures).where(eq(loginFailures.email, user.email));
        await tx.delete(users).where(eq(users.id, user.id));
      });
      return c.body(null, 204);
    }),
  );

  /**
   * Creates a farm owned by the caller. With `id`, claims an existing local farm id instead: only
   * allowed while the cloud knows nothing about that farm (no members, no rows, no farm tokens),
   * so nobody can take over a farm by learning its id. With `id` and `adopt`, the claimed farm
   * takes over an empty cloud farm the caller owns (members, plan, usage), e.g. the farm created
   * while buying a plan on the website before Orbit was installed.
   */
  routes.post(
    "/v1/farms",
    requireSession,
    wrap(async (c) => {
      const b = await body(c);
      const name = str(b.name, "name") as string;
      const timezone = str(b.timezone, "timezone", { optional: true }) ?? "UTC";
      const user = c.get("user");
      const ts = now().toISOString();
      if (b.id !== undefined) {
        if (typeof b.id !== "string" || !UUID.test(b.id)) {
          throw new ApiError(400, "bad_request", "id must be a uuid");
        }
        const farmId = b.id.toLowerCase();
        return db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${farmId}))`);
          const taken = await Promise.all([
            tx
              .select({ x: farmMembers.userId })
              .from(farmMembers)
              .where(eq(farmMembers.farmId, farmId))
              .limit(1),
            tx.select({ x: pg.farms.id }).from(pg.farms).where(eq(pg.farms.id, farmId)).limit(1),
            tx
              .select({ x: apiTokens.tokenHash })
              .from(apiTokens)
              .where(eq(apiTokens.farmId, farmId))
              .limit(1),
          ]);
          if (taken.some((rows) => rows.length > 0)) {
            const mine = await tx
              .select({ role: farmMembers.role })
              .from(farmMembers)
              .where(and(eq(farmMembers.farmId, farmId), eq(farmMembers.userId, user.id)));
            if (mine[0]) return c.json({ farm: { id: farmId, name, role: mine[0].role } });
            throw new ApiError(
              409,
              "farm_taken",
              "this farm is already in the cloud; ask one of its owners for an invite",
            );
          }
          if (b.adopt !== undefined) {
            if (typeof b.adopt !== "string" || !UUID.test(b.adopt)) {
              throw new ApiError(400, "bad_request", "adopt must be a uuid");
            }
            const from = b.adopt.toLowerCase();
            await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${from}))`);
            const [own] = await tx
              .select({ role: farmMembers.role })
              .from(farmMembers)
              .where(and(eq(farmMembers.farmId, from), eq(farmMembers.userId, user.id)));
            if (own?.role !== "owner") {
              throw new ApiError(403, "forbidden", "only an owner can move a farm's plan");
            }
            const data = await Promise.all(
              [
                pg.animals,
                pg.devices,
                pg.deviceBindings,
                pg.connectors,
                pg.observations,
                pg.cameras,
                pg.cameraLayouts,
              ].map((t) => tx.select({ id: t.id }).from(t).where(eq(t.farmId, from)).limit(1)),
            );
            if (data.some((rows) => rows.length > 0)) {
              throw new ApiError(
                409,
                "farm_not_empty",
                "your cloud farm already has data; open it in Orbit instead",
              );
            }
            const moved = { farmId };
            await tx.update(farmMembers).set(moved).where(eq(farmMembers.farmId, from));
            await tx.update(farmInvites).set(moved).where(eq(farmInvites.farmId, from));
            await tx.update(billingCustomers).set(moved).where(eq(billingCustomers.farmId, from));
            await tx.update(farmSubscriptions).set(moved).where(eq(farmSubscriptions.farmId, from));
            await tx.update(farmBudgets).set(moved).where(eq(farmBudgets.farmId, from));
            await tx.update(llmUsage).set(moved).where(eq(llmUsage.farmId, from));
            await tx.update(voiceUsage).set(moved).where(eq(voiceUsage.farmId, from));
            await tx.update(apiTokens).set(moved).where(eq(apiTokens.farmId, from));
            await tx.delete(pg.farms).where(eq(pg.farms.id, from));
            return c.json(
              { farm: { id: farmId, name, role: "owner" as const }, adoptedFrom: from },
              201,
            );
          }
          await tx.insert(farmMembers).values({ farmId, userId: user.id, role: "owner" });
          return c.json({ farm: { id: farmId, name, role: "owner" as const } }, 201);
        });
      }
      const farmId = crypto.randomUUID();
      const hlc = createHlc("cloud").tick();
      await db.transaction(async (tx) => {
        await tx.insert(pg.farms).values({
          id: farmId,
          name,
          timezone,
          farmId,
          createdAt: ts,
          updatedAt: ts,
          hlc,
          originDevice: "cloud",
        });
        await tx.insert(farmMembers).values({ farmId, userId: user.id, role: "owner" });
      });
      return c.json({ farm: { id: farmId, name, role: "owner" as const } }, 201);
    }),
  );

  routes.get(
    "/v1/farms/:farmId/members",
    requireSession,
    wrap(async (c) => {
      const farmId = farmIdParam(c);
      await actorRole(c, farmId);
      const members = await db
        .select({
          userId: farmMembers.userId,
          email: users.email,
          name: users.name,
          role: farmMembers.role,
          createdAt: farmMembers.createdAt,
        })
        .from(farmMembers)
        .innerJoin(users, eq(users.id, farmMembers.userId))
        .where(eq(farmMembers.farmId, farmId))
        .orderBy(asc(farmMembers.createdAt));
      return c.json({ members: members.map((m) => ({ ...m, createdAt: iso(m.createdAt) })) });
    }),
  );

  const targetRole = async (farmId: string, userId: string): Promise<FarmRole> => {
    const r = UUID.test(userId) ? await memberRole(db, farmId, userId) : null;
    if (!r) throw new ApiError(404, "not_found", "no such member");
    return r;
  };

  routes.patch(
    "/v1/farms/:farmId/members/:userId",
    requireSession,
    wrap(async (c) => {
      const farmId = farmIdParam(c);
      const userId = c.req.param("userId") ?? "";
      const actor = await actorRole(c, farmId);
      const next = role((await body(c)).role);
      const current = await targetRole(farmId, userId);
      if (!canManageMember(actor, current) || !assignableRoles(actor).includes(next)) {
        throw new ApiError(403, "forbidden", `a ${actor} may not make this change`);
      }
      if (current === "owner" && next !== "owner" && (await ownerCount(farmId)) <= 1) {
        throw new ApiError(409, "last_owner", "a farm needs at least one owner");
      }
      await db
        .update(farmMembers)
        .set({ role: next, updatedAt: now().toISOString() })
        .where(and(eq(farmMembers.farmId, farmId), eq(farmMembers.userId, userId)));
      return c.json({ member: { userId, role: next } });
    }),
  );

  routes.delete(
    "/v1/farms/:farmId/members/:userId",
    requireSession,
    wrap(async (c) => {
      const farmId = farmIdParam(c);
      const userId = c.req.param("userId") ?? "";
      const actor = await actorRole(c, farmId);
      const current = await targetRole(farmId, userId);
      const self = userId === c.get("user").id;
      if (!self && !canManageMember(actor, current)) {
        throw new ApiError(403, "forbidden", `a ${actor} may not remove this member`);
      }
      if (current === "owner" && (await ownerCount(farmId)) <= 1) {
        throw new ApiError(409, "last_owner", "a farm needs at least one owner");
      }
      await db
        .delete(farmMembers)
        .where(and(eq(farmMembers.farmId, farmId), eq(farmMembers.userId, userId)));
      return c.body(null, 204);
    }),
  );

  const inviteView = (i: typeof farmInvites.$inferSelect) => ({
    id: i.id,
    farmId: i.farmId,
    email: i.email,
    role: i.role,
    createdAt: iso(i.createdAt),
    expiresAt: iso(i.expiresAt),
  });

  routes.post(
    "/v1/farms/:farmId/invites",
    requireSession,
    wrap(async (c) => {
      const farmId = farmIdParam(c);
      const actor = await actorRole(c, farmId);
      const b = await body(c);
      const address = email(b.email);
      const invitedRole = role(b.role);
      if (!canManageMembers(actor) || !assignableRoles(actor).includes(invitedRole)) {
        throw new ApiError(403, "forbidden", `a ${actor} may not invite a ${invitedRole}`);
      }
      const [already] = await db
        .select({ id: users.id })
        .from(farmMembers)
        .innerJoin(users, eq(users.id, farmMembers.userId))
        .where(and(eq(farmMembers.farmId, farmId), eq(users.email, address)));
      if (already) throw new ApiError(409, "already_member", "this person is already a member");
      const code = randomToken(INVITE_PREFIX, 24);
      const [invite] = await db
        .insert(farmInvites)
        .values({
          farmId,
          email: address,
          role: invitedRole,
          tokenHash: await hashToken(code),
          invitedBy: c.get("user").id,
          createdAt: now().toISOString(),
          expiresAt: new Date(now().getTime() + INVITE_TTL_MS).toISOString(),
        })
        .returning();
      const [farm] = await db
        .select({ name: pg.farms.name })
        .from(pg.farms)
        .where(eq(pg.farms.id, farmId));
      await deliver(emails.invite(links, address, farm?.name ?? "a farm", invitedRole, code));
      return c.json({ invite: inviteView(invite as typeof farmInvites.$inferSelect), code }, 201);
    }),
  );

  routes.get(
    "/v1/farms/:farmId/invites",
    requireSession,
    wrap(async (c) => {
      const farmId = farmIdParam(c);
      if (!canManageMembers(await actorRole(c, farmId))) {
        throw new ApiError(403, "forbidden", "only owners and managers see invites");
      }
      const rows = await db
        .select()
        .from(farmInvites)
        .where(
          and(
            eq(farmInvites.farmId, farmId),
            isNull(farmInvites.acceptedAt),
            isNull(farmInvites.revokedAt),
            gt(farmInvites.expiresAt, now().toISOString()),
          ),
        )
        .orderBy(asc(farmInvites.createdAt));
      return c.json({ invites: rows.map(inviteView) });
    }),
  );

  routes.delete(
    "/v1/farms/:farmId/invites/:inviteId",
    requireSession,
    wrap(async (c) => {
      const farmId = farmIdParam(c);
      if (!canManageMembers(await actorRole(c, farmId))) {
        throw new ApiError(403, "forbidden", "only owners and managers revoke invites");
      }
      const inviteId = c.req.param("inviteId") ?? "";
      const updated = UUID.test(inviteId)
        ? await db
            .update(farmInvites)
            .set({ revokedAt: now().toISOString() })
            .where(
              and(
                eq(farmInvites.id, inviteId),
                eq(farmInvites.farmId, farmId),
                isNull(farmInvites.acceptedAt),
                isNull(farmInvites.revokedAt),
              ),
            )
            .returning({ id: farmInvites.id })
        : [];
      if (updated.length === 0) throw new ApiError(404, "not_found", "no open invite with this id");
      return c.body(null, 204);
    }),
  );

  routes.post(
    "/v1/invites/accept",
    requireSession,
    wrap(async (c) => {
      const code = str((await body(c)).code, "code", { max: 100 }) as string;
      const user = c.get("user");
      if (!user.emailVerified) {
        throw new ApiError(403, "email_unverified", "confirm your email address first");
      }
      const tokenHash = await hashToken(code);
      return db.transaction(async (tx) => {
        const [invite] = await tx
          .select()
          .from(farmInvites)
          .where(eq(farmInvites.tokenHash, tokenHash))
          .for("update");
        if (!invite) throw new ApiError(404, "not_found", "unknown invite code");
        if (invite.acceptedAt)
          throw new ApiError(409, "invite_used", "this invite was already used");
        if (invite.revokedAt)
          throw new ApiError(410, "invite_revoked", "this invite was withdrawn");
        if (Date.parse(invite.expiresAt) <= now().getTime()) {
          throw new ApiError(410, "invite_expired", "this invite has expired");
        }
        if (invite.email !== user.email) {
          throw new ApiError(403, "wrong_account", `this invite is for ${invite.email}`);
        }
        const ts = now().toISOString();
        const inserted = await tx
          .insert(farmMembers)
          .values({ farmId: invite.farmId, userId: user.id, role: invite.role })
          .onConflictDoNothing()
          .returning({ role: farmMembers.role });
        if (inserted.length === 0) {
          throw new ApiError(409, "already_member", "you are already a member of this farm");
        }
        await tx
          .update(farmInvites)
          .set({ acceptedAt: ts, acceptedBy: user.id })
          .where(eq(farmInvites.id, invite.id));
        return c.json({ farm: { id: invite.farmId, role: invite.role } });
      });
    }),
  );
}
