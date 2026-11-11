import type { Catalog } from "../../core";
import type { devices as en } from "../en/devices";

export const devices: Catalog<typeof en> = {
  "mode.cloud_api": "sky-API",
  "mode.local_api": "lokalt API",
  "mode.local_db": "lokal database",
  "mode.file_import": "filimport",
  "mode.custom": "egendefinert",

  "vendor.generic_csv": "CSV-import",
  "vendor.custom": "egendefinert",

  "time.never": "Aldri",
  "time.justNow": "Akkurat nå",
  "time.minutesAgo": { one: "for {count} min siden", other: "for {count} min siden" },
  "time.hoursAgo": { one: "for {count} time siden", other: "for {count} timer siden" },
  "time.daysAgo": { one: "for {count} dag siden", other: "for {count} dager siden" },

  "common.cancel": "Avbryt",
  "common.retry": "Prøv igjen",

  "page.title": "Tilkoblinger",
  "empty.title": "Ingen tilkoblinger ennå",

  "connector.toast.on": "Tilkoblingen er slått på",
  "connector.toast.off": "Tilkoblingen er slått av",
  "connector.toast.enabled": "{name} er nå slått på.",
  "connector.toast.paused": "{name} er nå satt på pause.",
  "connector.toast.error": "Kunne ikke oppdatere tilkoblingen",
  "sync.toast.done": "Synkroniseringen er ferdig",
  "sync.toast.description": "Hentet de nyeste målingene fra {name}.",
  "sync.toast.notice": "Melding om synkronisering",

  "connectors.error.title": "Kunne ikke laste tilkoblinger",
  "connectors.loading": "Laster tilkoblinger…",
  "connector.status.error": "Synkroniseringsfeil",
  "connector.status.enabled": "På",
  "connector.status.paused": "På pause",
  "connector.lastSync": "Sist synkronisert: {time}",
  "connector.turnOff": "Slå av",
  "connector.turnOn": "Slå på",
  "connector.syncNow": "Synkroniser nå",
  "connector.password": "Passord",
  "password.title": "Passord for {name}",
  "password.description":
    "Lagres i datamaskinens sikre nøkkelring og brukes bare av denne tilkoblingen. Orion ser det aldri.",
  "password.label": "Passord",
  "password.save": "Lagre passord",
  "password.toast.saved": "Passordet er lagret",
  "password.toast.error": "Kunne ikke lagre passordet",

  "connectNew.button": "Koble til med Orion",
  "connectNew.prompt": "Hjelp meg å koble til utstyr eller programvare på gården",
};
