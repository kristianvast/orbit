import type { Catalog } from "../../core";
import type { feedback as en } from "../en/feedback";

export const feedback: Catalog<typeof en> = {
  title: "Tilbakemelding",
  subtitle: "Fortell Orbit-teamet hva som ikke virker, hva som mangler, eller hva som fungerer bra",
  "kind.label": "Hva gjelder det?",
  "kind.issue": "Noe virker ikke",
  "kind.idea": "En idé eller et ønske",
  "kind.other": "Noe annet",
  "message.label": "Meldingen din",
  "message.placeholder": "Hva skjedde, eller hva ville hjulpet på gården din?",
  "email.label": "E-posten din (valgfritt)",
  "email.hint": "Bare hvis du vil ha svar.",
  privacy:
    "Sendes sammen med Orbit-versjonen og typen datamaskin. Gårdens data blir aldri tatt med.",
  send: "Send tilbakemelding",
  sent: "Takk. Tilbakemeldingen er sendt.",
  failed: "Kunne ikke sende tilbakemeldingen",
  unavailable:
    "Denne Orbit-installasjonen er ikke koblet til Orbit-skyen, så tilbakemelding kan ikke sendes herfra.",
  "share.body":
    "Har du laget en side eller en tilkobling med Orion som andre gårder kan ha nytte av? Be Orion dele den. Orbit-teamet går gjennom den før andre kan installere den.",
  "share.action": "Del noe jeg har laget",
  "share.prompt": "Jeg vil dele noe vi har laget med andre gårder",
  "shared.title": "Dette har du delt",
  "shared.status.pending": "Til vurdering",
  "shared.status.approved": "Godkjent",
  "shared.status.rejected": "Ikke tatt med",
};
