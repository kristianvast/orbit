import { useEffect, useRef, useState } from "react";
import { isTauriRuntime } from "./orion";

interface DownloadedUpdate {
  install(): Promise<void>;
}

/** Downloads a newer Orbit in the background; `restart` installs it and reopens the app. */
export function useAppUpdate(): { ready: boolean; restart: () => void } {
  const [ready, setReady] = useState(false);
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

  return { ready, restart };
}
