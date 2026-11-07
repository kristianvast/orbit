import type { Catalog } from "../../core";
import type { connection as en } from "../en/connection";

export const connection: Catalog<typeof en> = {
  "title.unauthorized": "Orion avviste sikkerhetsnøkkelen",
  "title.connecting": "Kobler til Orion på denne gårds-PC-en…",
  "title.unreachable": "Orion-assistenten kan ikke nås akkurat nå",
  "detail.unauthorized": "Start Orbit på nytt, så kan det avtales en ny lokal øktnøkkel med Orion.",
  "detail.waiting":
    "Venter på den lokale Orion-agenten på {url}. Gårdsdataene dine er trygge på denne PC-en og dukker opp av seg selv når tilkoblingen er på plass.",
  "state.connecting": "Kobler til",
  "state.reconnecting": "Kobler til på nytt",
  "state.closed": "Frakoblet",
  "state.unauthorized": "Ingen tilgang",
  retry: "Prøv å koble til igjen",
};
