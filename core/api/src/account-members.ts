import { assignableRoles, canManageMember, canManageMembers, type FarmRole } from "@orbit/schema";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import {
  type AccountEnv,
  ApiError,
  body,
  farmIdParam,
  role,
  UUID,
  usagePermission,
} from "./account-input";
import type { AccountRuntime } from "./account-runtime";
import { memberRole } from "./auth";
import { type CoreDb, farmMembers } from "./db";
import { memberViews } from "./member-usage";
export function registerMemberRoutes(
  routes: Hono<AccountEnv>,
  db: CoreDb,
  runtime: AccountRuntime,
) {
  const { now, requireSession, actorRole, ownerCount, wrap } = runtime;
  routes.get(
    "/v1/farms/:farmId/members",
    requireSession,
    wrap(async (c) => {
      const farmId = farmIdParam(c);
      const actor = await actorRole(c, farmId);
      const members = await memberViews(db, farmId, now());
      return c.json({
        members: members.map(({ usage, ...m }) =>
          canManageMembers(actor) || m.userId === c.get("user").id ? { ...m, usage } : m,
        ),
      });
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
      const b = await body(c);
      const permission = usagePermission(b);
      const current = await targetRole(farmId, userId);
      const next = b.role === undefined ? current : role(b.role);
      if (b.role === undefined && Object.keys(permission).length === 0)
        throw new ApiError(400, "bad_request", "provide role, useFarmPlan or monthlyTokenLimit");
      if (!canManageMember(actor, current) || !assignableRoles(actor).includes(next)) {
        throw new ApiError(403, "forbidden", `a ${actor} may not make this change`);
      }
      if (current === "owner" && next !== "owner" && (await ownerCount(farmId)) <= 1) {
        throw new ApiError(409, "last_owner", "a farm needs at least one owner");
      }
      if (
        next === "owner" &&
        current === "owner" &&
        (permission.useFarmPlan === false || permission.monthlyTokenLimit != null)
      )
        throw new ApiError(409, "owner_usage", "owners always have unrestricted farm plan access");
      await db
        .update(farmMembers)
        .set({
          ...permission,
          role: next,
          updatedAt: now().toISOString(),
          ...(next === "owner" ? { useFarmPlan: true, monthlyTokenLimit: null } : {}),
        })
        .where(and(eq(farmMembers.farmId, farmId), eq(farmMembers.userId, userId)));
      return c.json({
        member: (await memberViews(db, farmId, now())).find((m) => m.userId === userId),
      });
    }),
  );

  routes.patch(
    "/v1/farms/:farmId/me",
    requireSession,
    wrap(async (c) => {
      const farmId = farmIdParam(c);
      await actorRole(c, farmId);
      const b = await body(c);
      if (b.usageSource !== null && b.usageSource !== "farm" && b.usageSource !== "own")
        throw new ApiError(400, "bad_request", "usageSource must be farm, own or null");
      const userId = c.get("user").id;
      await db
        .update(farmMembers)
        .set({ usageSource: b.usageSource, updatedAt: now().toISOString() })
        .where(and(eq(farmMembers.farmId, farmId), eq(farmMembers.userId, userId)));
      return c.json({
        member: (await memberViews(db, farmId, now())).find((m) => m.userId === userId),
      });
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
}
