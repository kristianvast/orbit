// Factory for file-export connectors: the farmer saves a CSV/XML export from the vendor software
// and Orbit reads that file. Used by generic_csv and by every vendor adapter.
import { readFile } from "node:fs/promises";
import type { ConnectorVendor, DeviceKind } from "@orbit/schema/enums";
import { DEVICE_KINDS, SPECIES } from "@orbit/schema/enums";
import { type Static, Type } from "typebox";
import { type ParsedTable, parseCsv } from "./csv";
import { ConnectorConfigError, NotImplementedError } from "./errors";
import {
  type Connector,
  type ConnectorCategory,
  type ConnectorContext,
  defineConnector,
  type TestResult,
} from "./sdk";
import { ColumnMapping, DATE_ORDERS, type ImportSpec, importTable, resolveColumn } from "./tabular";
import { parseXmlRecords } from "./xml";

export const FileExportConfig = Type.Object({
  /** "file_export" reads a saved export file. "api" is reserved and throws NotImplementedError. */
  mode: Type.Optional(Type.Enum(["file_export", "api"])),
  /** Path of the export file on the farm PC. */
  path: Type.Optional(Type.String({ minLength: 1 })),
  format: Type.Optional(Type.Enum(["csv", "xml"])),
  /** Single character; auto-detected from the header line when omitted. */
  delimiter: Type.Optional(Type.String({ minLength: 1, maxLength: 1 })),
  /** XML only: the element that represents one record. */
  recordTag: Type.Optional(Type.String({ minLength: 1 })),
  /** Overrides individual fields of the adapter's default column mapping. */
  mapping: Type.Optional(Type.Partial(ColumnMapping)),
  defaultSpecies: Type.Optional(Type.Enum(SPECIES)),
  utcOffsetMinutes: Type.Optional(Type.Number({ minimum: -840, maximum: 840 })),
  dateOrder: Type.Optional(Type.Enum(DATE_ORDERS)),
  deviceKind: Type.Optional(Type.Enum(DEVICE_KINDS)),
});
export type FileExportConfig = Static<typeof FileExportConfig>;

export interface FileExportAdapter {
  id: string;
  vendor: ConnectorVendor;
  kind: ConnectorCategory;
  label: string;
  /** Undefined for generic_csv: the user must supply the whole mapping. */
  defaultMapping?: ColumnMapping;
  /** Device kind of the sensor/robot named by the deviceId column. */
  deviceKind?: DeviceKind;
  /** Kinds a user may pick through config.deviceKind. Defaults to just deviceKind. */
  allowedDeviceKinds?: readonly DeviceKind[];
  defaultFormat?: "csv" | "xml";
  defaultRecordTag?: string;
  defaultDateOrder?: "dmy" | "mdy";
}

function resolveSpec(a: FileExportAdapter, cfg: FileExportConfig): ImportSpec {
  const mapping = { ...a.defaultMapping, ...cfg.mapping } as Partial<ColumnMapping>;
  if (!mapping.animalId) {
    throw new ConnectorConfigError(`${a.id}: mapping.animalId is required`, [
      'name the column that holds the animal id, e.g. mapping: { animalId: "Cow" }',
    ]);
  }
  const deviceKind = cfg.deviceKind ?? a.deviceKind;
  const allowed = a.allowedDeviceKinds ?? (a.deviceKind ? [a.deviceKind] : []);
  if (cfg.deviceKind && !allowed.includes(cfg.deviceKind)) {
    throw new ConnectorConfigError(`${a.id}: deviceKind ${cfg.deviceKind} is not supported`, [
      `allowed: ${allowed.join(", ") || "none"}`,
    ]);
  }
  return {
    mapping: mapping as ColumnMapping,
    defaultSpecies: cfg.defaultSpecies ?? "cattle",
    utcOffsetMinutes: cfg.utcOffsetMinutes ?? 0,
    dateOrder: cfg.dateOrder ?? a.defaultDateOrder ?? "dmy",
    deviceKind,
    deviceVendor: a.vendor === "generic_csv" ? undefined : a.vendor,
  };
}

function parseText(a: FileExportAdapter, cfg: FileExportConfig, text: string): ParsedTable {
  const format = cfg.format ?? a.defaultFormat ?? "csv";
  if (format === "xml") {
    const tag = cfg.recordTag ?? a.defaultRecordTag;
    if (!tag) throw new ConnectorConfigError(`${a.id}: recordTag is required for xml`);
    return parseXmlRecords(text, tag);
  }
  return parseCsv(text, { delimiter: cfg.delimiter });
}

async function load(a: FileExportAdapter, cfg: FileExportConfig) {
  if (!cfg.path) throw new ConnectorConfigError(`${a.id}: path is required for file_export`);
  return parseText(a, cfg, await readFile(cfg.path, "utf8"));
}

function apiNotImplemented(a: FileExportAdapter): never {
  throw new NotImplementedError(`${a.vendor} API access for ${a.id} (use mode "file_export")`);
}

export function defineFileExportConnector(
  a: FileExportAdapter,
): Connector<typeof FileExportConfig> {
  return defineConnector({
    id: a.id,
    vendor: a.vendor,
    kind: a.kind,
    label: a.label,
    configSchema: FileExportConfig,
    async test(ctx: ConnectorContext<FileExportConfig>): Promise<TestResult> {
      if (ctx.config.mode === "api") apiNotImplemented(a);
      try {
        const spec = resolveSpec(a, ctx.config);
        const table = await load(a, ctx.config);
        if (resolveColumn(table.headers, spec.mapping.animalId) === undefined) {
          return {
            ok: false,
            message: `animal id column not found; file columns: ${table.headers.join(", ")}`,
          };
        }
        return {
          ok: true,
          message: `${table.rows.length} rows, columns: ${table.headers.join(", ")}`,
        };
      } catch (e) {
        if (e instanceof ConnectorConfigError) throw e;
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
    async sync(ctx: ConnectorContext<FileExportConfig>): Promise<void> {
      if (ctx.config.mode === "api") apiNotImplemented(a);
      const spec = resolveSpec(a, ctx.config);
      const table = await load(a, ctx.config);
      const stats = await importTable(ctx, table, spec);
      ctx.logger.info(`${a.id} import finished`, { ...stats });
    },
  });
}
