import { assignableRoles, canManageMembers, pg } from "@orbit/schema";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import {
  type AccountEnv,
  ApiError,
  body,
  email,
  farmIdParam,
  INVITE_PREFIX,
  INVITE_TTL_MS,
  iso,
  role,
  str,
  UUID,
  usagePermission,
} from "./account-input";
import type { AccountRuntime } from "./account-runtime";
import { hashToken, randomToken } from "./auth";
import { type CoreDb, farmInvites, farmMembers, users } from "./db";
import { emails } from "./mailer";
export function registerInviteRoutes(
  routes: Hono<AccountEnv>,
  db: CoreDb,
  runtime: AccountRuntime,
) {
  const { now, links, deliver, requireSession, actorRole, wrap } = runtime;
  const inviteView = (i: typeof farmInvites.$inferSelect) => ({
    id: i.id,
    farmId: i.farmId,
    email: i.email,
    role: i.role,
    useFarmPlan: i.useFarmPlan,
    monthlyTokenLimit: i.monthlyTokenLimit,
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
      const permission = usagePermission(b);
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
          ...permission,
          ...(invitedRole === "owner" ? { useFarmPlan: true, monthlyTokenLimit: null } : {}),
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
          .values({
            farmId: invite.farmId,
            userId: user.id,
            role: invite.role,
            useFarmPlan: invite.useFarmPlan,
            monthlyTokenLimit: invite.monthlyTokenLimit,
          })
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
