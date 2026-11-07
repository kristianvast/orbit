import type { OrionEndpoint } from "../../../lib/orion";

export function buildCameraWsUrl(
  endpoint: OrionEndpoint | null | undefined,
  cameraId: string,
): string {
  const trimmedId = cameraId.trim();
  const token = endpoint?.token?.trim() ?? "";
  if (!endpoint?.url || !token || !trimmedId) return "";
  try {
    const u = new URL(endpoint.url);
    if (u.protocol === "https:" || u.protocol === "wss:") {
      u.protocol = "wss:";
    } else if (u.protocol === "http:" || u.protocol === "ws:") {
      u.protocol = "ws:";
    } else {
      return "";
    }
    u.pathname = `/camera/${encodeURIComponent(token)}/${encodeURIComponent(trimmedId)}/ws`;
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return "";
  }
}

export function buildCameraSnapshotUrl(
  endpoint: OrionEndpoint | null | undefined,
  cameraId: string,
  cacheBustToken?: number,
): string {
  const trimmedId = cameraId.trim();
  const token = endpoint?.token?.trim() ?? "";
  if (!endpoint?.url || !token || !trimmedId) return "";
  try {
    const u = new URL(endpoint.url);
    if (u.protocol === "https:" || u.protocol === "wss:") {
      u.protocol = "https:";
    } else if (u.protocol === "http:" || u.protocol === "ws:") {
      u.protocol = "http:";
    } else {
      return "";
    }
    u.pathname = `/camera/${encodeURIComponent(token)}/${encodeURIComponent(trimmedId)}/frame.jpeg`;
    u.search = "";
    u.hash = "";
    if (cacheBustToken !== undefined) {
      u.searchParams.set("_t", String(cacheBustToken));
    }
    return u.toString();
  } catch {
    return "";
  }
}
