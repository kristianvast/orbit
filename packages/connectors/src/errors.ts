/** Raised by API-path stubs: the vendor API integration is intentionally not implemented yet. */
export class NotImplementedError extends Error {
  override name = "NotImplementedError";
  constructor(readonly feature: string) {
    super(`not implemented: ${feature}`);
  }
}

/** The connector config failed schema validation or is semantically unusable. */
export class ConnectorConfigError extends Error {
  override name = "ConnectorConfigError";
  constructor(
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(issues.length > 0 ? `${message}: ${issues.join("; ")}` : message);
  }
}

/** A vendor export file could not be parsed into rows or lacks a required column. */
export class ConnectorParseError extends Error {
  override name = "ConnectorParseError";
}

/** The writer refused a write (unknown reference, domain rule, ...). */
export class ConnectorWriteError extends Error {
  override name = "ConnectorWriteError";
}
