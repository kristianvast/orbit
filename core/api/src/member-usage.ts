import { and, eq, gte, sql } from "drizzle-orm";
import { type CoreDb, farmMembers, llmUsage, users, voiceUsage } from "./db";
import { monthStart } from "./entitlements";

export async function memberViews(db: CoreDb, farmId: string, now: Date) {
  const members = await db
    .select({
      userId: farmMembers.userId,
      email: users.email,
      name: users.name,
      role: farmMembers.role,
      createdAt: farmMembers.createdAt,
      useFarmPlan: farmMembers.useFarmPlan,
      monthlyTokenLimit: farmMembers.monthlyTokenLimit,
      usageSource: farmMembers.usageSource,
    })
    .from(farmMembers)
    .innerJoin(users, eq(users.id, farmMembers.userId))
    .where(eq(farmMembers.farmId, farmId));
  const [tokens, voice] = await Promise.all([
    db
      .select({
        userId: llmUsage.userId,
        farmTokens: sql<string>`coalesce(sum(case when ${llmUsage.accountId} = ${farmId} then ${llmUsage.totalTokens} else 0 end), 0)`,
        ownTokens: sql<string>`coalesce(sum(case when ${llmUsage.accountId} = ${llmUsage.userId} then ${llmUsage.totalTokens} else 0 end), 0)`,
      })
      .from(llmUsage)
      .where(and(eq(llmUsage.farmId, farmId), gte(llmUsage.createdAt, monthStart(now))))
      .groupBy(llmUsage.userId),
    db
      .select({
        userId: voiceUsage.userId,
        seconds: sql<string>`coalesce(sum(${voiceUsage.seconds}), 0)`,
      })
      .from(voiceUsage)
      .where(and(eq(voiceUsage.farmId, farmId), gte(voiceUsage.createdAt, monthStart(now))))
      .groupBy(voiceUsage.userId),
  ]);
  return members
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((m) => {
      const usage = tokens.find((t) => t.userId === m.userId);
      return {
        ...m,
        createdAt: new Date(m.createdAt).toISOString(),
        usage: {
          farmTokens: Number(usage?.farmTokens ?? 0),
          ownTokens: Number(usage?.ownTokens ?? 0),
          voiceSeconds: Number(voice.find((v) => v.userId === m.userId)?.seconds ?? 0),
        },
      };
    });
}
