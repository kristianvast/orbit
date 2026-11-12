import type { Catalog } from "../../core";
import type { access as en } from "../en/access";

export const access: Catalog<typeof en> = {
  title: "Skal Orion få gi deg en hånd på denne datamaskinen?",
  "lead.shell": "For å få dette gjort vil Orion kjøre en kommando på datamaskinen din.",
  "lead.browser": "For å få dette gjort vil Orion bruke en nettleser.",
  "lead.computer": "For å få dette gjort vil Orion se skjermen din og bruke mus og tastatur.",
  "point.commands": "Kjøre kommandoer og små programmer for å bygge og fikse ting for gården din.",
  "point.browser": "Bruke en nettleser til å slå opp ting og fylle ut skjemaer.",
  "point.screen":
    "Bruke andre programmer på skjermen når det ikke finnes noen annen vei inn, akkurat som du ville gjort.",
  "point.asks":
    "Orion forteller hva den gjør og spør deg før noe stort, som å slette eller installere.",
  risk: "Orbit er gratis programvare med åpen kildekode, levert som den er. Orion er hjelpsom, men kan gjøre feil, så når du tillater det, godtar du risikoen for det den gjør på denne datamaskinen. Du kan slå dette av når som helst i Innstillinger.",
  allow: "Tillat Orion",
  decline: "Ikke nå",
};
