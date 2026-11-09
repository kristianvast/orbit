import { genericCsvConnector } from "./adapters/generic-csv";
import type { Connector } from "./sdk";

export { genericCsvConnector } from "./adapters/generic-csv";
export * from "./csv";
export * from "./errors";
export * from "./file-export";
export * from "./memory-writer";
export * from "./sdk";
export * from "./tabular";
export * from "./xml";

export const builtinConnectors: readonly Connector[] = [genericCsvConnector];

export function getConnector(id: string): Connector | undefined {
  return builtinConnectors.find((c) => c.id === id);
}
