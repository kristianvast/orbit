import type { Messages } from "../../core";

export const pages = {
  "missing.title": "This page is not here",
  "missing.description":
    "Orion has not built it yet, or it was removed. Ask Orion to make a new page.",
  "cards.label": "Your cards",
  "cards.frameTitle": "{title} summary",
} as const satisfies Messages;
