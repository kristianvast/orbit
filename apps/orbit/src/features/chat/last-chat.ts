// Which conversation the farmer was in when they last left Chat. Kept in sessionStorage, so it is
// forgotten when Orbit closes: a new start of the app always begins with a new conversation.

const KEY = "orbit.chat.last";
export const RESUME_WINDOW_MS = 30 * 60_000;

interface LastChat {
  id: string;
  at: number;
}

function read(): LastChat | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const value = raw ? (JSON.parse(raw) as Partial<LastChat>) : null;
    return value && typeof value.id === "string" && typeof value.at === "number"
      ? { id: value.id, at: value.at }
      : null;
  } catch {
    // Storage can be blocked or hold something else; then there is simply nothing to resume.
    return null;
  }
}

export function rememberChat(id: string, now = Date.now()): void {
  window.sessionStorage.setItem(KEY, JSON.stringify({ id, at: now }));
}

export function forgetChat(): void {
  window.sessionStorage.removeItem(KEY);
}

/** The conversation last used in this run of Orbit, with whether that was recent enough to return to. */
export function lastChat(now = Date.now()): { id: string; recent: boolean } | null {
  const last = read();
  return last ? { id: last.id, recent: now - last.at <= RESUME_WINDOW_MS } : null;
}
