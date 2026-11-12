import type { Catalog } from "../../core";
import type { access as en } from "../en/access";

export const access: Catalog<typeof en> = {
  lead: "Orion trenger dette for å få gjort det du ba om. Den spør bare én gang.",
  "shell.title": "Skal Orion få kjøre kommandoer?",
  "shell.what":
    "Orion kjører kommandoer og små programmer på denne datamaskinen for å bygge og fikse ting for gården din, som å sjekke at et verktøy er installert.",
  "shell.care":
    "Den forteller hva hver kommando er til og spør deg før noe stort, som å slette filer eller installere programvare.",
  "browser.title": "Skal Orion få bruke en nettleser?",
  "browser.what":
    "Orion åpner nettsider i sin egen nettleser for å slå opp ting, fylle ut skjemaer og logge inn der du ber om det.",
  "browser.care":
    "Innlogginger blir på denne datamaskinen, og Orion lagrer aldri passordene dine i minnet sitt.",
  "computer.title": "Skal Orion få bruke skjermen, musen og tastaturet?",
  "computer.what":
    "Orion kan se på skjermen og bruke et annet program, som et besetnings- eller melkeprogram, når det ikke finnes noen annen vei inn.",
  "computer.care":
    "Den gjør dette bare for jobben du ba om, og du kan stoppe den når som helst fra chatten.",
  risk: "Orbit er gratis programvare med åpen kildekode, levert som den er. Orion er hjelpsom, men kan gjøre feil, så når du tillater dette, godtar du risikoen for det den gjør på denne datamaskinen. Du kan slå det av når som helst i Innstillinger.",
  allow: "Tillat",
  decline: "Ikke nå",
};
