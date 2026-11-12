import { pg } from "@orbit/schema";
import { asc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { type AccountEnv, PAID_STATUSES } from "./account-input";
import type { AccountRuntime } from "./account-runtime";
import { type CoreDb, farmMembers, farmSubscriptions } from "./db";
import { entitlements } from "./entitlements";
export function registerProfileRoute(
  routes: Hono<AccountEnv>,
  db: CoreDb,
  runtime: AccountRuntime,
) {
  const { now, userView, requireSession } = runtime;
  routes.get("/v1/me", requireSession, async (c) => {
    const user = c.get("user");
    const rows = await db
      .select({
        farmId: farmMembers.farmId,
        role: farmMembers.role,
        name: pg.farms.name,
        useFarmPlan: farmMembers.useFarmPlan,
        monthlyTokenLimit: farmMembers.monthlyTokenLimit,
        usageSource: farmMembers.usageSource,
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
    const personal = await entitlements(db, { kind: "personal", id: user.id }, now());
    return c.json({ user: userView(user), farms, personal: { plan: personal.plan.id } });
  });
}
