import type { Catalog } from "../../core";
import type { localUi as en } from "../en/localUi";

export const localUi: Catalog<typeof en> = {
  title: "Din Orbit",
  subtitle: "Orion kan endre selve Orbit ved å bygge din egen versjon av appen på denne PC-en",
  "badge.none": "Original",
  "badge.ready": "Din versjon",
  "badge.broken": "Sikker modus",
  "badge.unknown": "Ukjent",
  "none.body":
    "Du bruker den originale Orbit. Be Orion om å endre et skjermbilde, så bygger den din egen versjon; du kan alltid komme tilbake hit.",
  "ready.body": "Din egen versjon av Orbit er klar. Orbit åpner den hver gang den starter.",
  "broken.body":
    "Din egen versjon startet ikke sist, så Orbit åpnet den originale appen. Be Orion om å fikse den, eller åpne den igjen.",
  "local.body": "Du bruker din egen versjon av Orbit, laget av Orion på denne PC-en.",
  "local.noReturn": "Start Orbit på nytt for å åpne den originale appen.",
  builtAt: "Bygget {time}",
  open: "Åpne din Orbit",
  useOriginal: "Bruk original Orbit",
  failed: "Kunne ikke bytte",
};
