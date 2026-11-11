import type { AppAction } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptionalNote(value: unknown): { ok: true; note?: string } | { ok: false } {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  return trimmed.length > 0 ? { ok: true, note: trimmed } : { ok: true };
}

function parsePositiveRef(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return null;
  return value;
}

function hasControlOrWhitespace(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function isValidInAppPath(path: string): boolean {
  const trimmed = path.trim();
  if (trimmed.length === 0) return false;
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return false;
  if (hasControlOrWhitespace(trimmed)) return false;
  return true;
}

export function parseAppAction(parameters: unknown): AppAction | null {
  if (!isRecord(parameters)) return null;
  const action = parameters.action;
  if (typeof action !== "string") return null;

  switch (action) {
    case "look":
      return { action: "look" };
    case "clear":
      return { action: "clear" };
    case "highlight":
    case "click": {
      const ref = parsePositiveRef(parameters.ref);
      const parsedNote = parseOptionalNote(parameters.note);
      if (ref === null || !parsedNote.ok) return null;
      return parsedNote.note !== undefined
        ? { action, ref, note: parsedNote.note }
        : { action, ref };
    }
    case "go": {
      if (typeof parameters.path !== "string" || parameters.path.trim().length === 0) {
        return null;
      }
      const parsedNote = parseOptionalNote(parameters.note);
      if (!parsedNote.ok) return null;
      const cleanPath = parameters.path.trim();
      return parsedNote.note !== undefined
        ? { action: "go", path: cleanPath, note: parsedNote.note }
        : { action: "go", path: cleanPath };
    }
    default:
      return null;
  }
}
