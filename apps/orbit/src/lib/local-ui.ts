// Hand-off between the shipped UI and the farm's own build that Orion serves at /app/<token>/.
// The shipped UI asks Orion at startup and moves to the local build when it is ready; the local
// build reports that it booted, reloads when Orion rebuilds it, and can send the farmer back.
import { createOrionClient, type LocalUiStatus, type OrionClient } from "@orbit/protocol";
import { useEffect } from "react";
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
