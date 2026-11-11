import type { webcrypto } from "node:crypto";
import type { FetchLike } from "./shape";

interface GoogleKey extends webcrypto.JsonWebKey {
  kid?: string;
}

export interface GoogleIdentity {
  sub: string;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
}

/** Verify GIS credentials using Google's signing keys; never trust token-provided key URLs. */
export function createGoogleIdentityVerifier(
  clientIds: readonly string[],
  now: () => Date,
  doFetch: FetchLike = fetch,
) {
  let cached: { keys: GoogleKey[]; expiresAt: number } | undefined;
  let pending: Promise<GoogleKey[]> | undefined;
  const keys = async () => {
    if (cached && cached.expiresAt > now().getTime()) return cached.keys;
    if (!pending) {
      pending = (async () => {
        const response = await doFetch("https://www.googleapis.com/oauth2/v3/certs", {
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error("Google signing keys unavailable");
        const jwks = (await response.json()) as { keys: GoogleKey[] };
        if (!Array.isArray(jwks.keys)) throw new Error("Invalid Google signing keys");
        const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(response.headers.get("cache-control") ?? "");
        const age = Number(response.headers.get("age") ?? 0);
        cached = {
          keys: jwks.keys,
          expiresAt: now().getTime() + Math.max(0, Number(maxAge?.[1] ?? 0) - age) * 1000,
        };
        return cached.keys;
      })().finally(() => {
        pending = undefined;
      });
    }
    return pending;
  };
  return async (credential: unknown): Promise<GoogleIdentity> => {
    if (typeof credential !== "string" || credential.length > 16_384) {
      throw new Error("Invalid Google credential");
    }
    const parts = credential.split(".");
    if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) {
      throw new Error("Invalid Google JWT");
    }
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString());
    const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString());
    const seconds = now().getTime() / 1000;
    const skew = 60;
    if (
      header?.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      !claims ||
      !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss) ||
      typeof claims.aud !== "string" ||
      !clientIds.includes(claims.aud) ||
      typeof claims.sub !== "string" ||
      !claims.sub ||
      claims.sub.length > 255 ||
      !Number.isFinite(claims.exp) ||
      !Number.isFinite(claims.iat) ||
      claims.exp <= seconds - skew ||
      claims.iat > seconds + skew ||
      claims.exp <= claims.iat
    ) {
      throw new Error("Invalid Google claims");
    }
    const jwk = (await keys()).find(
      (key) =>
        key.kid === header.kid &&
        key.kty === "RSA" &&
        (!key.alg || key.alg === "RS256") &&
        (!key.use || key.use === "sig"),
    );
    if (!jwk) throw new Error("Unknown Google signing key");
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      Buffer.from(signaturePart, "base64url"),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
    if (!valid) throw new Error("Invalid Google signature");
    return claims as GoogleIdentity;
  };
}
