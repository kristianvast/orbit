import { and, eq, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import {
  type AccountEnv,
  ApiError,
  body,
  email,
  newPassword,
  RESEND_COOLDOWN_MS,
  RESETS_PER_HOUR,
  str,
} from "./account-input";
import type { AccountRuntime } from "./account-runtime";
import { hashToken } from "./auth";
import { type CoreDb, emailTokens, loginFailures, userSessions, users } from "./db";
import { emails } from "./mailer";
export function registerEmailRoutes(routes: Hono<AccountEnv>, db: CoreDb, runtime: AccountRuntime) {
  const { now, links, deliver, issueEmailToken, tokensSince, requireSession, wrap } = runtime;
  routes.post(
    "/v1/auth/verify-email",
    wrap(async (c) => {
      const code = str((await body(c)).token, "token", { max: 100 }) as string;
      const tokenHash = await hashToken(code);
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(emailTokens)
          .where(and(eq(emailTokens.tokenHash, tokenHash), eq(emailTokens.purpose, "verify")))
          .for("update");
        const [user] = row ? await tx.select().from(users).where(eq(users.id, row.userId)) : [];
        if (
          !row ||
          !user ||
          row.usedAt ||
          Date.parse(row.expiresAt) <= now().getTime() ||
          user.email !== row.email
        ) {
          throw new ApiError(410, "link_invalid", "this link is invalid or has expired");
        }
        const ts = now().toISOString();
        await tx
          .update(emailTokens)
          .set({ usedAt: ts })
          .where(eq(emailTokens.tokenHash, tokenHash));
        await tx
          .update(users)
          .set({ emailVerifiedAt: user.emailVerifiedAt ?? ts })
          .where(eq(users.id, user.id));
        return c.json({ email: user.email, emailVerified: true });
      });
    }),
  );

  routes.post(
    "/v1/auth/resend-verification",
    requireSession,
    wrap(async (c) => {
      const user = c.get("user");
      if (user.emailVerified) throw new ApiError(409, "already_verified", "email already verified");
      if ((await tokensSince(user.id, "verify", now().getTime() - RESEND_COOLDOWN_MS)) > 0) {
        throw new ApiError(429, "too_many_attempts", "wait a minute before asking again");
      }
      await deliver(
        emails.verify(links, user.email, await issueEmailToken(user.id, user.email, "verify")),
      );
      return c.json({ sent: true }, 202);
    }),
  );

  routes.post(
    "/v1/auth/password-reset",
    wrap(async (c) => {
      const address = email((await body(c)).email);
      const [user] = await db.select().from(users).where(eq(users.email, address)).limit(1);
      if (
        user &&
        (await tokensSince(user.id, "reset", now().getTime() - 60 * 60 * 1000)) < RESETS_PER_HOUR
      ) {
        const code = await issueEmailToken(user.id, address, "reset");
        // Not awaited, so the answer takes the same time whether or not the account exists.
        void deliver(emails.reset(links, address, code));
      }
      return c.json({ sent: true }, 202);
    }),
  );

  routes.post(
    "/v1/auth/password-reset/confirm",
    wrap(async (c) => {
      const b = await body(c);
      const code = str(b.token, "token", { max: 100 }) as string;
      const password = newPassword(b.password);
      const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
      const tokenHash = await hashToken(code);
      const address = await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(emailTokens)
          .where(and(eq(emailTokens.tokenHash, tokenHash), eq(emailTokens.purpose, "reset")))
          .for("update");
        const [user] = row ? await tx.select().from(users).where(eq(users.id, row.userId)) : [];
        if (
          !row ||
          !user ||
          row.usedAt ||
          Date.parse(row.expiresAt) <= now().getTime() ||
          user.email !== row.email
        ) {
          throw new ApiError(410, "link_invalid", "this link is invalid or has expired");
        }
        const ts = now().toISOString();
        await tx
          .update(users)
          .set({ passwordHash, emailVerifiedAt: user.emailVerifiedAt ?? ts })
          .where(eq(users.id, user.id));
        await tx
          .update(emailTokens)
          .set({ usedAt: ts })
          .where(
            and(
              eq(emailTokens.userId, user.id),
              eq(emailTokens.purpose, "reset"),
              isNull(emailTokens.usedAt),
            ),
          );
        await tx
          .update(userSessions)
          .set({ revokedAt: ts })
          .where(and(eq(userSessions.userId, user.id), isNull(userSessions.revokedAt)));
        await tx.delete(loginFailures).where(eq(loginFailures.email, user.email));
        return user.email;
      });
      await deliver(emails.passwordChanged(address));
      return c.body(null, 204);
    }),
  );
}
