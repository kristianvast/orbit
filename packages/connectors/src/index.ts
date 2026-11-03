import { allflexConnector } from "./adapters/allflex";
import { cowmanagerConnector } from "./adapters/cowmanager";
import { delproConnector } from "./adapters/delpro";
import { genericCsvConnector } from "./adapters/generic-csv";
import { lelyT4cConnector } from "./adapters/lely-t4c";
import { smaxtecConnector } from "./adapters/smaxtec";
import type { Connector } from "./sdk";

export { allflexConnector, allflexDefaultMapping } from "./adapters/allflex";
export { cowmanagerConnector, cowmanagerDefaultMapping } from "./adapters/cowmanager";
export { delproConnector, delproDefaultMapping } from "./adapters/delpro";
export { genericCsvConnector } from "./adapters/generic-csv";
export { lelyT4cConnector, lelyT4cDefaultMapping } from "./adapters/lely-t4c";
export { smaxtecConnector, smaxtecDefaultMapping } from "./adapters/smaxtec";
export * from "./csv";
export * from "./errors";
export * from "./file-export";
export * from "./memory-writer";
export * from "./sdk";
export * from "./tabular";
export * from "./xml";

export const builtinConnectors: readonly Connector[] = [
  genericCsvConnector,
  lelyT4cConnector,
  delproConnector,
  smaxtecConnector,
  cowmanagerConnector,
  allflexConnector,
];

export function getConnector(id: string): Connector | undefined {
  return builtinConnectors.find((c) => c.id === id);
}
