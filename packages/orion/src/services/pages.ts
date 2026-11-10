// Custom pages: small web pages Orion builds in <workspace>/pages/<id>/ and the app shows in its nav.
// Orion serves them over its localhost HTTP server under /pages/<token>/, so relative asset links
// work and only someone holding the session token can load them.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { type CustomPage, PROTOCOL_VERSION } from "@orbit/protocol";

export const PAGES_DIR = "pages";
const PAGE_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const ENTRY = "index.html";
/** A card is one HTML file directly inside the page folder. */
const CARD_ENTRY = /^[A-Za-z0-9_][A-Za-z0-9._-]*\.html$/;

interface PageManifest {
  title?: unknown;
  description?: unknown;
  /** File name of the page's Home card, e.g. "card.html". */
  card?: unknown;
}

function readManifest(dir: string): PageManifest {
  const file = join(dir, "page.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PageManifest;
  } catch {
    return {};
  }
}

function titleFromId(id: string): string {
  const words = id.replaceAll(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function listPages(workspaceDir: string, token: string): CustomPage[] {
  const root = join(workspaceDir, PAGES_DIR);
  if (!existsSync(root)) return [];
  const pages: CustomPage[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PAGE_ID.test(entry.name)) continue;
    const dir = join(root, entry.name);
    if (!existsSync(join(dir, ENTRY))) continue;
    const manifest = readManifest(dir);
    const title =
      typeof manifest.title === "string" && manifest.title.trim()
        ? manifest.title.trim()
        : titleFromId(entry.name);
    const base = `/${PAGES_DIR}/${encodeURIComponent(token)}/${entry.name}`;
    const card =
      typeof manifest.card === "string" &&
      CARD_ENTRY.test(manifest.card) &&
      resolvePageFile(workspaceDir, entry.name, manifest.card)
        ? manifest.card
        : null;
    pages.push({
      id: entry.name,
      title,
      ...(typeof manifest.description === "string" && manifest.description.trim()
        ? { description: manifest.description.trim() }
        : {}),
      path: `${base}/${ENTRY}`,
      ...(card ? { card: { path: `${base}/${card}` } } : {}),
    });
  }
  return pages.sort((a, b) => a.title.localeCompare(b.title));
}

/** Resolves a request path inside pages/<id>/ to a real file, or null if it is missing or escapes. */
export function resolvePageFile(workspaceDir: string, id: string, rel: string): string | null {
  if (!PAGE_ID.test(id)) return null;
  const pageDir = join(workspaceDir, PAGES_DIR, id);
  const target = join(pageDir, rel || ENTRY);
  if (!existsSync(pageDir) || !existsSync(target)) return null;
  const realDir = realpathSync(pageDir);
  const realTarget = realpathSync(target);
  if (!realTarget.startsWith(realDir + sep)) return null;
  return realTarget;
}

/**
 * Browser helper served at /pages/<token>/_orbit.js. Pages load it with
 * <script src="../_orbit.js"></script> and get window.orbit: query, mutate, request, on(event) and
 * cameraFrame(id). It also applies the app's theme and language, which the app passes as ?theme= and ?lang=.
 */
export const PAGE_SDK = `(() => {
  const match = location.pathname.match(/^\\/${PAGES_DIR}\\/([^/]+)\\//);
  const token = match ? decodeURIComponent(match[1]) : "";
  const query = new URLSearchParams(location.search);
  const theme = query.get("theme") ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
  if (query.get("lang")) document.documentElement.lang = query.get("lang");
  const pending = new Map();
  const listeners = new Set();
  let ws = null;
  let ready = null;
  let seq = 0;
  function send(type, params) {
    const id = "page-" + ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, type, ...params }));
    });
  }
  function connect() {
    ready = new Promise((resolve, reject) => {
      ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
      ws.onopen = () => {
        send("hello", { token, protocolVersion: ${PROTOCOL_VERSION}, client: "orbit-page" }).then(resolve, reject);
      };
      ws.onmessage = (event) => {
        const frame = JSON.parse(event.data);
        if (frame.type !== "response") {
          for (const fn of listeners) fn(frame);
          return;
        }
        const waiter = pending.get(frame.id);
        if (!waiter) return;
        pending.delete(frame.id);
        if (frame.ok) waiter.resolve(frame.result);
        else waiter.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }));
      };
      ws.onclose = () => {
        for (const waiter of pending.values()) waiter.reject(new Error("Orion connection closed"));
        pending.clear();
        ready = null;
        reject(new Error("Orion connection closed"));
      };
    });
    return ready;
  }
  async function request(type, params = {}) {
    await (ready ?? connect());
    return send(type, params);
  }
  window.orbit = {
    request,
    query: (query, params = {}) => request("db.query", { query, params }),
    mutate: (mutation, params = {}) => request("db.mutate", { mutation, params }),
    /** URL of a camera's latest still picture; add a changing query string to refresh it. */
    cameraFrame: (cameraId) =>
      "/camera/" + encodeURIComponent(token) + "/" + encodeURIComponent(cameraId) + "/frame.jpeg",
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
})();
`;
