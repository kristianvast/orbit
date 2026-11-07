import type { Messages } from "../../core";

export const pages = {
  "missing.title": "This page is not here",
  "missing.description":
    "Orion has not built it yet, or it was removed. Ask Orion to make a new page.",
} as const satisfies Messages;
