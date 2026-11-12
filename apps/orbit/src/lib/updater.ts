import type { LocalUiStatus } from "@orbit/protocol";
import { useEffect, useRef, useState } from "react";
import { isTauriRuntime } from "./orion";

interface DownloadedUpdate {
  version: string;
  install(): Promise<void>;
}

/**
 * What Update does: a farm running its own build that is not on the new version yet first has
 * Orion move its changes across in chat ("chat"); otherwise the update just installs ("restart").
 */
export function updateAction(
  version: string | null,
  farmBuild: LocalUiStatus | null,
): "chat" | "restart" {
  if (!version || !farmBuild || farmBuild.state === "none") return "restart";
  return farmBuild.baseVersion === version ? "restart" : "chat";
}

/** Downloads a newer Orbit in the background; `restart` installs it and reopens the app. */
export function useAppUpdate(): { ready: boolean; version: string | null; restart: () => void } {
  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const downloaded = useRef<DownloadedUpdate | null>(null);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    void (async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (!update || cancelled) return;
        await update.download();
        if (cancelled) return;
        downloaded.current = update;
        setVersion(update.version);
        setReady(true);
      } catch (error) {
        // Offline or the release feed is unreachable: Orbit keeps running on this version.
        console.warn("orbit: update check failed:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const restart = () => {
    const update = downloaded.current;
    if (!update) return;
    void (async () => {
      await update.install();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    })();
  };

  return { ready, version, restart };
}
