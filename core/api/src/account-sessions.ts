import { and, desc, eq, gt, isNull, ne, or } from "drizzle-orm";
import type { Hono } from "hono";
import {
  type AccountEnv,
  ApiError,
  body,
  iso,
  newPassword,
  UUID,
  verifyPassword,
} from "./account-input";
import type { AccountRuntime } from "./account-runtime";
import { hashToken } from "./auth";
import {
  type CoreDb,
  farmInvites,
  farmMembers,
  farmSubscriptions,
  hardwareOrders,
  userSessions,
  users,
} from "./db";
import { emails } from "./mailer";
export function registerSessionRoutes(
  routes: Hono<AccountEnv>,
  db: CoreDb,
  runtime: AccountRuntime,
) {
  const { now, deliver, requireSession, wrap } = runtime;
  routes.post(
    "/v1/me/password",
    requireSession,
    wrap(async (c) => {
      const b = await body(c);
      const user = c.get("user");
      const [row] = await db.select().from(users).where(eq(users.id, user.id));
      const current = typeof b.currentPassword === "string" ? b.currentPassword : "";
      if (!(await verifyPassword(current, row?.passwordHash))) {
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
}
