import type { Catalog } from "../../core";
import type { pages as en } from "../en/pages";

export const pages: Catalog<typeof en> = {
  "missing.title": "Denne siden finnes ikke",
  "missing.description":
    "Orion har ikke laget den ennå, eller så er den fjernet. Be Orion om å lage en ny side.",
  "cards.label": "Dine kort",
  "cards.frameTitle": "Sammendrag: {title}",
};
