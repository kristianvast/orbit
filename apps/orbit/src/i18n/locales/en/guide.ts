import type { Messages } from "../../core";

export const guide = {
  "overlay.region": "Orion screen guide",
  "note.withText": "Orion: {note}",
  "note.pointing": "Orion: {label}",
  "note.pointingFallback": "Orion is pointing here",
  "note.close": "Dismiss Orion guide",
  "announcement.withText": "Orion is pointing to {label}: {note}",
  "announcement.noteOnly": "Orion: {note}",
  "announcement.pointing": "Orion is pointing to {label}",
  "browser.region": "Orion's browser",
  "browser.untitled": "Web page",
  "browser.frameAlt": "Page open in Orion's browser: {title}",
  "browser.noteWithText": "Orion: {note}",
  "browser.pointing": "Orion is pointing here",
} as const satisfies Messages;
