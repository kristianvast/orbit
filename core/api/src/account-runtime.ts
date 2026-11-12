import type { FarmRole } from "@orbit/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import {
  type AccountOptions,
  ApiError,
  type Ctx,
  EMAIL_TOKEN_PREFIX,
  fail,
  RESET_TTL_MS,
  TERMS_VERSION,
  VERIFY_TTL_MS,
} from "./account-input";
import { hashToken, memberRole, randomToken, resolveSession, type SessionUser } from "./auth";
import { type CoreDb, emailTokens, farmMembers } from "./db";
import { createGoogleIdentityVerifier } from "./google-sign-in";
import type { EmailMessage } from "./mailer";
export function createAccountRuntime(db: CoreDb, options: AccountOptions) {
  const { now, mailer, links } = options;
  const termsVersion = options.termsVersion ?? TERMS_VERSION;
  const throttle = options.loginThrottle ?? { maxFailures: 10, windowMs: 15 * 60 * 1000 };
  const googleClientIds = options.googleClientIds ?? [];
  const verifyGoogle = createGoogleIdentityVerifier(googleClientIds, now, options.fetch);

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

  return {
    now,
    mailer,
    links,
    termsVersion,
    throttle,
    verifyGoogle,
    googleClientIds,
    userView,
    deliver,
    issueEmailToken,
    tokensSince,
    requireSession,
    actorRole,
    ownerCount,
    wrap,
  };
}
export type AccountRuntime = ReturnType<typeof createAccountRuntime>;
