// Hand-off between the shipped UI and the farm's own build that Orion serves at /app/<token>/.
// The shipped UI asks Orion at startup and moves to the local build when it is ready; the local
// build reports that it booted, reloads when Orion rebuilds it, and can send the farmer back.
import {
  createOrionClient,
  DEV_SERVER_URL,
  DEV_TOKEN,
  type LocalUiStatus,
  type OrionClient,
} from "@orbit/protocol";
import { useCallback, useEffect, useState } from "react";
import { localUiBasename } from "./local-ui-path";
import { isTauriRuntime, type OrionEndpoint, resolveOrionEndpoint, useOrion } from "./orion";

export { localUiBasename, localUiEndpoint } from "./local-ui-path";

const RETURN_KEY = "orbit.localUi.return";
const HANDOFF_TIMEOUT_MS = 5000;

export function httpOrigin(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

export function localUiReturnUrl(): string | null {
  return window.sessionStorage.getItem(RETURN_KEY);
}

export function captureLocalUiReturn(): void {
  if (!localUiBasename()) return;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const target = params.get("return");
  if (!target) return;
  window.sessionStorage.setItem(RETURN_KEY, target);
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

function handoffEnabled(): boolean {
  if (localUiBasename()) return false;
  if (new URLSearchParams(window.location.search).has("safe")) return false;
  return isTauriRuntime() || import.meta.env?.VITE_LOCAL_UI_HANDOFF === "1";
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms));
}

export async function openLocalUi(client: OrionClient, endpoint: OrionEndpoint): Promise<void> {
  const status = await client.request("localUi.launched", {});
  if (!status.path) return;
  const back = new URL(window.location.href);
  back.searchParams.delete("safe");
  window.location.replace(
    `${httpOrigin(endpoint.url)}${status.path}#return=${encodeURIComponent(back.toString())}`,
  );
}

/**
 * Runs in the shipped UI at startup. Resolves true when the window is moving to the local build.
 * Any failure (Orion not up yet, no build, a build that never booted) keeps the shipped UI.
 */
export async function handOffToLocalUi(): Promise<boolean> {
  if (!handoffEnabled()) return false;
  const endpoint = await resolveOrionEndpoint();
  const client = createOrionClient(endpoint.url, endpoint.token, {
    clientName: "@orbit/app-handoff",
    reconnect: false,
  });
  try {
    await Promise.race([client.ready(), timeout(HANDOFF_TIMEOUT_MS)]);
    const status: LocalUiStatus = await client.request("localUi.status", {});
    if (status.state !== "ready") return false;
    await openLocalUi(client, endpoint);
    return true;
  } catch (error) {
    // Startup boundary: the shipped UI is always a valid fallback, so log and carry on.
    console.warn("orbit: staying on the shipped UI:", error);
    return false;
  } finally {
    client.close();
  }
}

export function useLocalUiLifecycle(): void {
  const { client, state } = useOrion();
  useEffect(() => {
    if (!localUiBasename() || !client || state !== "open") return;
    void client.request("localUi.booted", {});
    return client.on("localUi.updated", (ev) => {
      if (ev.state === "ready") window.location.reload();
    });
  }, [client, state]);
}

/** The farm's own build as Orion reports it, kept current while `enabled`; null until known. */
export function useLocalUiStatus(enabled: boolean): LocalUiStatus | null {
  const { client, state } = useOrion();
  const [status, setStatus] = useState<LocalUiStatus | null>(null);
  useEffect(() => {
    if (!enabled || !client || state !== "open") return;
    let cancelled = false;
    void (async () => {
      try {
        const current = await client.request("localUi.status", {});
        if (!cancelled) setStatus(current);
      } catch (error) {
        // Without it Update just installs, as it did before farm builds could be updated.
        console.warn("orbit: could not read the farm build status:", error);
      }
    })();
    const off = client.on("localUi.updated", (ev) => setStatus(ev));
    return () => {
      cancelled = true;
      off();
    };
  }, [enabled, client, state]);
  return status;
}

export function useLocalUiReady(): { ready: boolean; open: () => void } {
  const { client, endpoint } = useOrion();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (localUiBasename() || !client) {
      setReady(false);
      return;
    }
    return client.on("localUi.updated", (ev) => {
      setReady(ev.state === "ready");
    });
  }, [client]);

  const open = useCallback(() => {
    if (!client) return;
    void (async () => {
      const target =
        endpoint ??
        (await resolveOrionEndpoint().catch(() => ({
          url: DEV_SERVER_URL,
          token: DEV_TOKEN,
        })));
      await openLocalUi(client, target);
    })();
  }, [client, endpoint]);

  return { ready, open };
}
