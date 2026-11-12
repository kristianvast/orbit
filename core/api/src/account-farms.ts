import { createHlc, pg } from "@orbit/schema";
import { and, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { type AccountEnv, ApiError, body, str, UUID } from "./account-input";
import type { AccountRuntime } from "./account-runtime";
import {
  apiTokens,
  billingCustomers,
  type CoreDb,
  farmBudgets,
  farmInvites,
  farmMembers,
  farmSubscriptions,
  llmUsage,
  voiceUsage,
} from "./db";
export function registerFarmRoutes(routes: Hono<AccountEnv>, db: CoreDb, runtime: AccountRuntime) {
  const { now, requireSession, wrap } = runtime;
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
            await tx
              .update(llmUsage)
              .set({ accountId: farmId })
              .where(eq(llmUsage.accountId, from));
            await tx
              .update(voiceUsage)
              .set({ accountId: farmId })
              .where(eq(voiceUsage.accountId, from));
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
}
