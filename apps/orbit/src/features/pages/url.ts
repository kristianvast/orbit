import { DEV_SERVER_URL } from "@orbit/protocol";
import type { OrionEndpoint } from "../../lib/orion";

export type PageTheme = "light" | "dark";

/**
 * URL of a page or card file on Orion's origin. The frame cannot see the app around it, so the
 * app's theme and language travel in the query string and Orion's page helper applies them.
 */
export function customPageUrl(
  endpoint: OrionEndpoint | null,
  path: string,
  look: { theme: PageTheme; lang: string },
): string {
  const origin = new URL(endpoint?.url ?? DEV_SERVER_URL);
  origin.protocol = origin.protocol === "wss:" ? "https:" : "http:";
  const url = new URL(path, origin.origin);
  url.searchParams.set("theme", look.theme);
  url.searchParams.set("lang", look.lang);
  return url.toString();
}
