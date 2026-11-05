// Accounts, farm membership and invites:
//   POST /v1/auth/register | /v1/auth/login | /v1/auth/logout, GET /v1/me, POST /v1/farms,
//   GET|PATCH|DELETE /v1/farms/:farmId/members[/:userId],
//   GET|POST|DELETE /v1/farms/:farmId/invites[/:inviteId], POST /v1/invites/accept.
// Passwords are argon2id hashes (Bun.password); session tokens and invite codes are stored only as
// SHA-256 hashes. Invites are single-use, expire, and only the invited email address can accept.
import {
  assignableRoles,
  canManageMember,
  canManageMembers,
  createHlc,
  type FarmRole,
  isFarmRole,
  pg,
} from "@orbit/schema";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import {
  createSession,
  hashToken,
  memberRole,
  randomToken,
  resolveSession,
  type SessionUser,
} from "./auth";
import { apiTokens, type CoreDb, farmInvites, farmMembers, userSessions, users } from "./db";

export const INVITE_PREFIX = "orb_i_";
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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
  const { now } = options;
  const throttle = options.loginThrottle ?? { maxFailures: 10, windowMs: 15 * 60 * 1000 };
  const failures = new Map<string, { count: number; resetAt: number }>();
  const routes = app as unknown as Hono<AccountEnv>;

  const userView = (u: SessionUser) => ({ id: u.id, email: u.email, name: u.name });

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
      const password = b.password;
      if (
        typeof password !== "string" ||
        password.length < PASSWORD_MIN ||
        password.length > PASSWORD_MAX
      ) {
        throw new ApiError(
          400,
          "weak_password",
          `password must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters`,
        );
      }
      const name = str(b.name, "name", { optional: true });
      const deviceName = str(b.deviceName, "deviceName", { optional: true });
      const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
      const [created] = await db
        .insert(users)
        .values({ email: address, name, passwordHash })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id, email: users.email, name: users.name });
      if (!created) throw new ApiError(409, "email_taken", "an account with this email exists");
      const session = await createSession(db, created.id, deviceName, now());
      return c.json({ user: userView(created), session }, 201);
    }),
  );

  routes.post(
    "/v1/auth/login",
    wrap(async (c) => {
      const b = await body(c);
      const address = email(b.email);
      const password = typeof b.password === "string" ? b.password : "";
      const t = now().getTime();
      const entry = failures.get(address);
      if (entry && entry.resetAt > t && entry.count >= throttle.maxFailures) {
        throw new ApiError(429, "too_many_attempts", "too many failed sign-ins; try again later");
      }
      const [user] = await db.select().from(users).where(eq(users.email, address)).limit(1);
      const ok = await Bun.password.verify(
        password.slice(0, PASSWORD_MAX),
        user?.passwordHash ?? (await DUMMY_HASH),
      );
      if (!user || !ok) {
        const fresh = !entry || entry.resetAt <= t;
        failures.set(address, {
          count: fresh ? 1 : entry.count + 1,
          resetAt: fresh ? t + throttle.windowMs : entry.resetAt,
        });
        throw new ApiError(401, "invalid_credentials", "wrong email or password");
      }
      failures.delete(address);
      const deviceName = str(b.deviceName, "deviceName", { optional: true });
      const session = await createSession(db, user.id, deviceName, now());
      return c.json({ user: userView(user), session });
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
    const farms = await db
      .select({ farmId: farmMembers.farmId, role: farmMembers.role, name: pg.farms.name })
      .from(farmMembers)
      .leftJoin(pg.farms, eq(pg.farms.id, farmMembers.farmId))
      .where(eq(farmMembers.userId, user.id))
      .orderBy(asc(farmMembers.createdAt));
    return c.json({ user: userView(user), farms });
  });

  /**
   * Creates a farm owned by the caller. With `id`, claims an existing local farm id instead: only
   * allowed while the cloud knows nothing about that farm (no members, no rows, no farm tokens),
   * so nobody can take over a farm by learning its id.
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
