import type { CameraInput, DbMutateResult } from "@orbit/protocol";
import { Discovery } from "onvif";
import type { Repository, WriteOrigin } from "../db/repo";
import type { SecretStore } from "../secrets";

export interface DiscoveredCamera {
  /** WS-Discovery endpoint reference (urn:uuid:...). */
  urn: string;
  xaddr: string | null;
  host: string | null;
  manufacturer: string | null;
  model: string | null;
  name: string | null;
}

interface RawProbeMatch {
  probeMatches?: {
    probeMatch?: {
      endpointReference?: { address?: string };
      XAddrs?: string;
      scopes?: string | { _?: string };
    };
  };
}

function scopeValue(scopes: string[], key: string): string | null {
  const prefix = `onvif://www.onvif.org/${key}/`;
  const hit = scopes.find((s) => s.toLowerCase().startsWith(prefix));
  return hit ? decodeURIComponent(hit.slice(prefix.length)).replaceAll("_", " ") : null;
}

export function parseProbeMatch(raw: RawProbeMatch): DiscoveredCamera | null {
  const match = raw.probeMatches?.probeMatch;
  const urn = match?.endpointReference?.address;
  if (!match || !urn) return null;
  const scopeText = typeof match.scopes === "string" ? match.scopes : (match.scopes?._ ?? "");
  const scopes = scopeText.split(/\s+/).filter(Boolean);
  const xaddr = match.XAddrs?.split(/\s+/).find(Boolean) ?? null;
  let host: string | null = null;
  try {
    host = xaddr ? new URL(xaddr).hostname : null;
  } catch {
    host = null;
  }
  const name = scopeValue(scopes, "name");
  return {
    urn,
    xaddr,
    host,
    manufacturer: scopeValue(scopes, "mfr") ?? scopeValue(scopes, "manufacturer") ?? name,
    model: scopeValue(scopes, "hardware"),
    name,
  };
}

export class CameraService {
  constructor(
    private readonly repo: Repository,
    private readonly secrets: SecretStore,
  ) {}

  /**
   * ONVIF WS-Discovery on the LAN. ORION_FAKE_CAMERAS (JSON array of DiscoveredCamera) replaces the
   * network probe for tests and demos.
   */
  async discover(timeoutMs = 3000): Promise<DiscoveredCamera[]> {
    const fake = process.env.ORION_FAKE_CAMERAS;
    if (fake) return JSON.parse(fake) as DiscoveredCamera[];
    const timeout = Math.min(Math.max(timeoutMs, 500), 15_000);
    return new Promise((resolvePromise, reject) => {
      const onError = () => {};
      Discovery.on("error", onError);
      try {
        Discovery.probe({ timeout, resolve: false }, (_errors, found) => {
          Discovery.removeListener("error", onError);
          const cams = ((found ?? []) as RawProbeMatch[])
            .map(parseProbeMatch)
            .filter((c): c is DiscoveredCamera => c !== null);
          resolvePromise(cams);
        });
      } catch (error) {
        Discovery.removeListener("error", onError);
        reject(error);
      }
    });
  }

  /** Stores credentials in the secret store; the database only gets credential_ref. */
  async upsert(input: CameraInput, origin?: Partial<WriteOrigin>): Promise<DbMutateResult> {
    const { username, password, ...camera } = input;
    const id = camera.id ?? crypto.randomUUID();
    let credentialRef: string | undefined;
    if (password !== undefined || username !== undefined) {
      credentialRef = `camera:${id}`;
      await this.secrets.set(
        credentialRef,
        JSON.stringify({ username: username ?? "", password: password ?? "" }),
      );
    }
    return this.repo.upsertCamera(
      { ...camera, ...(credentialRef ? { credentialRef } : {}) },
      origin,
      camera.id ? undefined : id,
    );
  }
}
