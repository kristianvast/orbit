import { join } from "node:path";
import type { ConnectorLogger } from "../src/sdk";

export const fixture = (name: string) => join(import.meta.dir, "fixtures", name);

export function collectingLogger() {
  const warnings: { message: string; fields?: Record<string, unknown> }[] = [];
  const logger: ConnectorLogger = {
    debug() {},
    info() {},
    warn: (message, fields) => {
      warnings.push({ message, fields });
    },
    error() {},
  };
  return { logger, warnings };
}
