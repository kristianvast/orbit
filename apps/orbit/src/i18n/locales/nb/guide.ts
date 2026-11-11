import type { Catalog } from "../../core";
import type { guide as en } from "../en/guide";

export const guide: Catalog<typeof en> = {
  "overlay.region": "Orion skjermveiviser",
  "note.withText": "Orion: {note}",
  "note.pointing": "Orion: {label}",
  "note.pointingFallback": "Orion peker her",
  "note.close": "Lukk Orions veiviser",
  "announcement.withText": "Orion peker på {label}: {note}",
  "announcement.noteOnly": "Orion: {note}",
  "announcement.pointing": "Orion peker på {label}",
  "browser.region": "Orions nettleser",
  "browser.untitled": "Nettside",
  "browser.frameAlt": "Side åpen i Orions nettleser: {title}",
  "browser.noteWithText": "Orion: {note}",
  "browser.pointing": "Orion peker her",
};
