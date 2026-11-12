import { and, eq, gte, sql } from "drizzle-orm";
import { type CoreDb, farmMembers, llmUsage } from "./db";
import { type BillingAccount, entitlements, monthStart } from "./entitlements";

type RequestAccount = {
  readonly farmId: string | null;
  readonly userId: string | null;
};

export async function resolveBillingAccount(db: CoreDb, request: RequestAccount, now: Date) {
  const { farmId, userId } = request;
  const [member] =
    farmId && userId
      ? await db
          .select()
          .from(farmMembers)
          .where(and(eq(farmMembers.farmId, farmId), eq(farmMembers.userId, userId)))
      : [];
  const farm = farmId ? await entitlements(db, farmId, now) : null;
  const allowed = member?.useFarmPlan === true;
  const useFarm =
    farmId &&
    (!userId ||
      (allowed &&
        member?.usageSource !== "own" &&
        (member?.usageSource === "farm" || (farm?.tokenAllowance ?? 0) > 0)));
  const account: BillingAccount = useFarm
    ? { kind: "farm", id: farmId }
    : { kind: "personal", id: userId ?? "" };
  const entitlement = account.kind === "farm" && farm ? farm : await entitlements(db, account, now);
  return { ...account, entitlement, member: member ?? null };
}

export async function memberFarmTokens(
  db: CoreDb,
  member: { readonly farmId: string; readonly userId: string },
  now: Date,
): Promise<number> {
  const [row] = await db
    .select({ used: sql<string>`coalesce(sum(${llmUsage.totalTokens}), 0)` })
    .from(llmUsage)
    .where(
      and(
        eq(llmUsage.farmId, member.farmId),
        eq(llmUsage.userId, member.userId),
        eq(llmUsage.accountId, member.farmId),
        gte(llmUsage.createdAt, monthStart(now)),
      ),
    );
  return Number(row?.used ?? 0);
}

export const MEMBER_LIMIT = {
  error: {
    code: "member_limit",
    message:
      "farm allowance for you is used up this month; switch to your own plan or ask the farm owner",
  },
} as const;
