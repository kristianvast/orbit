import { and, eq, isNull } from "drizzle-orm";
import { apiTokens, type CoreDb } from "./db";

export type TokenResolver = (token: string) => Promise<string | null>;

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Buffer.from(digest).toString("hex");
}

/** Generates a new random token (returned once) and stores only its hash. */
export async function issueToken(db: CoreDb, farmId: string, name?: string): Promise<string> {
  const token = `orb_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
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
