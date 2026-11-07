import type { FarmRole } from "@orbit/schema";
import { and, eq, gt, isNull } from "drizzle-orm";
import { apiTokens, type CoreDb, farmMembers, userSessions, users } from "./db";

export type TokenResolver = (token: string) => Promise<string | null>;

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Buffer.from(digest).toString("hex");
}

export const SESSION_PREFIX = "orb_s_";
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url")}`;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
}

/** Who is calling a farm-scoped route: a member through a user session, or a legacy farm token. */
export interface Principal {
  farmId: string;
  role: FarmRole;
  userId: string | null;
}

export async function createSession(
  db: CoreDb,
  userId: string,
  deviceName: string | null,
  now: Date,
): Promise<{ token: string; expiresAt: string }> {
  const token = randomToken(SESSION_PREFIX);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await db
    .insert(userSessions)
    .values({ tokenHash: await hashToken(token), userId, deviceName, expiresAt });
  return { token, expiresAt };
}

export async function resolveSession(
  db: CoreDb,
  token: string,
  now: Date,
): Promise<SessionUser | null> {
  if (!token.startsWith(SESSION_PREFIX)) return null;
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      emailVerifiedAt: users.emailVerifiedAt,
    })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(
      and(
        eq(userSessions.tokenHash, await hashToken(token)),
        isNull(userSessions.revokedAt),
        gt(userSessions.expiresAt, now.toISOString()),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    emailVerified: row.emailVerifiedAt !== null,
  };
}

export async function memberRole(
  db: CoreDb,
  farmId: string,
  userId: string,
): Promise<FarmRole | null> {
  const [row] = await db
    .select({ role: farmMembers.role })
    .from(farmMembers)
    .where(and(eq(farmMembers.farmId, farmId), eq(farmMembers.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}

/** Generates a new random token (returned once) and stores only its hash. */
export async function issueToken(db: CoreDb, farmId: string, name?: string): Promise<string> {
  const token = randomToken("orb_");
  await db.insert(apiTokens).values({ tokenHash: await hashToken(token), farmId, name });
  return token;
}

/**
 * Maps a bearer token to its farm id. `staticTokens` ("token:farmId,...") is for local
 * development only (CORE_STATIC_TOKENS); production tokens live hashed in api_tokens.
 */
export function createTokenResolver(db: CoreDb, staticTokens = ""): TokenResolver {
  const fixed = new Map(
    staticTokens
      .split(",")
      .map((pair) => pair.trim().split(":"))
      .filter((p): p is [string, string] => p.length === 2 && !!p[0] && !!p[1]),
  );
  return async (token) => {
    const known = fixed.get(token);
    if (known) return known;
    const row = await db
      .select({ farmId: apiTokens.farmId })
      .from(apiTokens)
      .where(and(eq(apiTokens.tokenHash, await hashToken(token)), isNull(apiTokens.revokedAt)))
      .limit(1);
    return row[0]?.farmId ?? null;
  };
}
