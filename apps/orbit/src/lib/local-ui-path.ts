// Path helpers for the local UI build served by Orion at /app/<token>/. Only a type import, so
// lib/orion.ts can use them without a runtime import cycle.
import type { OrionEndpoint } from "./orion";

const LOCAL_PATH = /^\/app\/([^/]+)/;

export function localUiBasename(): string | undefined {
  const match = window.location.pathname.match(LOCAL_PATH);
  return match ? match[0] : undefined;
}

/** The local build is served by Orion itself, so its endpoint is its own origin and path token. */
export function localUiEndpoint(): OrionEndpoint | null {
  const match = window.location.pathname.match(LOCAL_PATH);
  if (!match?.[1]) return null;
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return { url: `${scheme}//${window.location.host}/ws`, token: decodeURIComponent(match[1]) };
}
