import { pg } from "@orbit/schema";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { type AccountEnv, ApiError, body, verifyPassword } from "./account-input";
import type { AccountRuntime } from "./account-runtime";
import {
  apiTokens,
  type CoreDb,
  farmInvites,
  farmMembers,
  farmSubscriptions,
  hardwareOrders,
  loginFailures,
  users,
} from "./db";
export function registerDeleteRoute(routes: Hono<AccountEnv>, db: CoreDb, runtime: AccountRuntime) {
  const { requireSession, wrap } = runtime;
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
      if (!(await verifyPassword(password, row?.passwordHash))) {
        throw new ApiError(401, "invalid_credentials", "password is wrong");
      }
      await db.transaction(async (tx) => {
        const [personal] = await tx
          .select()
          .from(farmSubscriptions)
          .where(eq(farmSubscriptions.farmId, user.id));
        if (
          personal &&
          ["active", "trialing", "past_due", "unpaid"].includes(personal.status) &&
          !personal.cancelAtPeriodEnd
        )
          throw new ApiError(409, "subscription_active", "cancel your plan before deleting");
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
}
