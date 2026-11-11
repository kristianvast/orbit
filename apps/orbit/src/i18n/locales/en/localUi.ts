import type { Messages } from "../../core";

export const localUi = {
  title: "Your Orbit",
  "badge.none": "Original",
  "badge.ready": "Your build",
  "badge.broken": "Safe mode",
  "badge.unknown": "Unknown",
  "none.body":
    "You are using the original Orbit. Ask Orion to change a screen and it builds your own copy; you can come back here any time.",
  "ready.body": "Your own build of Orbit is ready. Orbit opens it every time it starts.",
  "broken.body":
    "Your own build did not start last time, so Orbit opened the original app. Ask Orion to fix it, or open it again.",
  "local.body": "You are using your own build of Orbit, made by Orion on this PC.",
  "local.noReturn": "Restart Orbit to open the original app.",
  builtAt: "Built {time}",
  open: "Open your Orbit",
  useOriginal: "Use original Orbit",
  failed: "Could not switch",
} as const satisfies Messages;
