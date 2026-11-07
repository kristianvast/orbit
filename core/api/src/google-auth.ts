import { createSign } from "node:crypto";
import type { FetchLike } from "./shape";
import { object, string } from "./stripe";

class GoogleAuthError extends Error {
  constructor(
    readonly source: string,
    message: string,
  ) {
    super(message);
  }
}

export function createGoogleTokenProvider(doFetch: FetchLike = fetch) {
  let cached: { readonly token: string; readonly expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;
  const refresh = async () => {
    const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const onGcp = Boolean(
      process.env.K_SERVICE || process.env.GCE_METADATA_HOST || process.env.GAE_ENV,
    );
    let token: string;
    let expiresIn = 3600;
    if (onGcp) {
      const host = process.env.GCE_METADATA_HOST ?? "metadata.google.internal";
      const response = await doFetch(
        `http://${host}/computeMetadata/v1/instance/service-accounts/default/token`,
        {
          headers: { "Metadata-Flavor": "Google" },
          signal: AbortSignal.timeout(3000),
        },
      );
      if (!response.ok)
        throw new GoogleAuthError("metadata", `Metadata token failed: ${response.status}`);
      const data = object(await response.json());
      token = string(data.access_token, "access_token");
      if (typeof data.expires_in === "number") expiresIn = data.expires_in;
    } else if (credentials) {
      const data = object(await Bun.file(credentials).json());
      const email = string(data.client_email, "client_email");
      const privateKey = string(data.private_key, "private_key");
      const issued = Math.floor(Date.now() / 1000);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
        iss: email,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        aud: "https://oauth2.googleapis.com/token",
        iat: issued,
        exp: issued + 3600,
      })}`;
      const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
      const response = await doFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: `${unsigned}.${signature}`,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok)
        throw new GoogleAuthError("service_account", `OAuth token failed: ${response.status}`);
      const result = object(await response.json());
      token = string(result.access_token, "access_token");
      if (typeof result.expires_in === "number") expiresIn = result.expires_in;
    } else {
      if (process.env.NODE_ENV === "production")
        throw new GoogleAuthError(
          "adc",
          "Configure a GCP service identity or GOOGLE_APPLICATION_CREDENTIALS",
        );
      const child = Bun.spawn(["gcloud", "auth", "application-default", "print-access-token"], {
        env: process.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exit !== 0) throw new GoogleAuthError("gcloud", `ADC token failed: ${stderr.trim()}`);
      token = string(stdout.trim(), "access token");
      // gcloud may reuse an existing ADC token, so its remaining lifetime can be under an hour.
      const info = await doFetch(
        `https://oauth2.googleapis.com/tokeninfo?${new URLSearchParams({ access_token: token })}`,
        {
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!info.ok)
        throw new GoogleAuthError("gcloud", `Token lifetime lookup failed: ${info.status}`);
      const lifetime = object(await info.json()).expires_in;
      expiresIn = Number(lifetime);
      if (!Number.isFinite(expiresIn) || expiresIn <= 0)
        throw new GoogleAuthError("gcloud", "Token has no remaining lifetime");
    }
    cached = { token, expiresAt: Date.now() + expiresIn * 1000 };
    return token;
  };
  return async (): Promise<string> => {
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    if (!pending)
      pending = refresh().finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
