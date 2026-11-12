import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Hono } from "hono";
import {
  type AccountEnv,
  ApiError,
  body,
  EMAIL,
  email,
  newPassword,
  str,
  verifyPassword,
} from "./account-input";
import type { AccountRuntime } from "./account-runtime";
import { createSession, hashToken } from "./auth";
import { type CoreDb, loginFailures, userSessions, users } from "./db";
import type { GoogleIdentity } from "./google-sign-in";
import { emails } from "./mailer";
export function registerSignInRoutes(
  routes: Hono<AccountEnv>,
  db: CoreDb,
  runtime: AccountRuntime,
) {
  const {
    now,
    links,
    termsVersion,
    throttle,
    verifyGoogle,
    googleClientIds,
    userView,
    deliver,
    issueEmailToken,
    requireSession,
    wrap,
  } = runtime;
  routes.post(
    "/v1/auth/register",
    wrap(async (c) => {
      const b = await body(c);
      const address = email(b.email);
      const password = newPassword(b.password);
      if (b.acceptTerms !== true) {
        throw new ApiError(400, "terms_required", "accept the terms of service to sign up");
      }
      const name = str(b.name, "name", { optional: true });
      const deviceName = str(b.deviceName, "deviceName", { optional: true });
      const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
      const ts = now().toISOString();
      const [created] = await db
        .insert(users)
        .values({
          email: address,
          name,
          passwordHash,
          termsVersion,
          termsAcceptedAt: ts,
          dataConsentAt: b.dataConsent === true ? ts : null,
        })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id, email: users.email, name: users.name });
      if (!created) throw new ApiError(409, "email_taken", "an account with this email exists");
      const session = await createSession(db, created.id, deviceName, now());
      await deliver(
        emails.verify(links, address, await issueEmailToken(created.id, address, "verify")),
      );
      return c.json({ user: userView({ ...created, emailVerified: false }), session }, 201);
    }),
  );

  routes.post(
    "/v1/auth/login",
    wrap(async (c) => {
      const b = await body(c);
      const address = email(b.email);
      const password = typeof b.password === "string" ? b.password : "";
      const t = now().getTime();
      const windowStart = new Date(t - throttle.windowMs).toISOString();
      const [recent] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(loginFailures)
        .where(and(eq(loginFailures.email, address), gte(loginFailures.at, windowStart)));
      if (Number(recent?.n ?? 0) >= throttle.maxFailures) {
        throw new ApiError(429, "too_many_attempts", "too many failed sign-ins; try again later");
      }
      const [user] = await db.select().from(users).where(eq(users.email, address)).limit(1);
      const ok = await verifyPassword(password, user?.passwordHash);
      if (!user || !ok) {
        await db
          .delete(loginFailures)
          .where(and(eq(loginFailures.email, address), lt(loginFailures.at, windowStart)));
        await db.insert(loginFailures).values({ email: address, at: new Date(t).toISOString() });
        throw new ApiError(401, "invalid_credentials", "wrong email or password");
      }
      await db.delete(loginFailures).where(eq(loginFailures.email, address));
      const deviceName = str(b.deviceName, "deviceName", { optional: true });
      const session = await createSession(db, user.id, deviceName, now());
      return c.json({
        user: userView({ ...user, emailVerified: user.emailVerifiedAt !== null }),
        session,
      });
    }),
  );

  routes.post(
    "/v1/auth/google",
    wrap(async (c) => {
      if (googleClientIds.length === 0) {
        throw new ApiError(503, "google_disabled", "Google sign-in is not configured");
      }
      const b = await body(c);
      let identity: GoogleIdentity;
      try {
        identity = await verifyGoogle(b.credential);
      } catch {
        throw new ApiError(401, "invalid_google_token", "invalid Google sign-in token");
      }
      if (
        identity.email_verified !== true ||
        typeof identity.email !== "string" ||
        identity.email.length > 200 ||
        !EMAIL.test(identity.email)
      ) {
        throw new ApiError(400, "google_email_unverified", "Google email must be verified");
      }
      const address = identity.email.toLowerCase();
      const deviceName = str(b.deviceName, "deviceName", { optional: true });
      const ts = now().toISOString();
      const result = await db.transaction(async (tx) => {
        const bySub = () =>
          tx.select().from(users).where(eq(users.googleSub, identity.sub)).limit(1).for("update");
        let [user] = await bySub();
        let created = false;
        if (!user) {
          [user] = await tx
            .select()
            .from(users)
            .where(eq(users.email, address))
            .limit(1)
            .for("update");
          if (!user) {
            if (b.acceptTerms !== true) {
              throw new ApiError(400, "terms_required", "accept the terms of service to sign up");
            }
            [user] = await tx
              .insert(users)
              .values({
                email: address,
                googleSub: identity.sub,
                name: typeof identity.name === "string" ? identity.name.slice(0, 200) : null,
                emailVerifiedAt: ts,
                termsVersion,
                termsAcceptedAt: ts,
                dataConsentAt: b.dataConsent === true ? ts : null,
              })
              .onConflictDoNothing()
              .returning();
            created = !!user;
            if (!user) {
              [user] = await bySub();
              if (!user) {
                [user] = await tx
                  .select()
                  .from(users)
                  .where(eq(users.email, address))
                  .limit(1)
                  .for("update");
              }
            }
          }
          if (!user || (user.googleSub !== null && user.googleSub !== identity.sub)) {
            throw new ApiError(401, "invalid_google_token", "invalid Google sign-in token");
          }
          if (user.googleSub === null) {
            [user] = await tx
              .update(users)
              .set({ googleSub: identity.sub, emailVerifiedAt: user.emailVerifiedAt ?? ts })
              .where(eq(users.id, user.id))
              .returning();
          }
        }
        if (!user) throw new Error("Google account was not saved");
        const session = await createSession(tx, user.id, deviceName, now());
        return {
          user: userView({ ...user, emailVerified: user.emailVerifiedAt !== null }),
          session,
          created,
        };
      });
      return c.json(result, result.created ? 201 : 200);
    }),
  );

  routes.post("/v1/auth/logout", requireSession, async (c) => {
    await db
      .update(userSessions)
      .set({ revokedAt: now().toISOString() })
      .where(eq(userSessions.tokenHash, await hashToken(c.get("sessionToken"))));
    return c.body(null, 204);
  });
}
