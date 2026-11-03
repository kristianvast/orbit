// Table-to-Orbit mapping engine shared by generic_csv and every vendor file-export adapter.
import type { AnimalSex, DeviceKind, Species } from "@orbit/schema/enums";
import { isWearableKind, OBSERVATION_KINDS, SPECIES } from "@orbit/schema/enums";
import { type Static, Type } from "typebox";
import type { ParsedTable } from "./csv";
import { ConnectorParseError } from "./errors";
import type { ConnectorLogger, ConnectorWriter, ObservationInput } from "./sdk";

/** One header name, or several candidates tried in order (first one present in the file wins). */
export const ColumnRef = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
]);
export type ColumnRef = Static<typeof ColumnRef>;

export const ObservationMapping = Type.Object({
  column: ColumnRef,
  kind: Type.Enum(OBSERVATION_KINDS),
  /** Multiplier applied to the parsed number, e.g. 0.4536 for lb to kg. */
  scale: Type.Optional(Type.Number()),
  /** Stored as valueJson.unit next to the number. */
  unit: Type.Optional(Type.String()),
});
export type ObservationMapping = Static<typeof ObservationMapping>;

export const ColumnMapping = Type.Object({
  animalId: ColumnRef,
  earTag: Type.Optional(ColumnRef),
  nationalId: Type.Optional(ColumnRef),
  name: Type.Optional(ColumnRef),
  breed: Type.Optional(ColumnRef),
  sex: Type.Optional(ColumnRef),
  birthDate: Type.Optional(ColumnRef),
  group: Type.Optional(ColumnRef),
  species: Type.Optional(ColumnRef),
  /** Sensor or robot id for the row. Wearables are bound to the animal; other devices are only referenced. */
  deviceId: Type.Optional(ColumnRef),
  timestamp: Type.Optional(ColumnRef),
  /** Separate time-of-day column when the export splits date and time. */
  time: Type.Optional(ColumnRef),
  observations: Type.Optional(Type.Array(ObservationMapping)),
});
export type ColumnMapping = Static<typeof ColumnMapping>;

export const DATE_ORDERS = ["dmy", "mdy"] as const;
export type DateOrder = (typeof DATE_ORDERS)[number];

export interface ImportSpec {
  mapping: ColumnMapping;
  defaultSpecies: Species;
  /** Offset of the export's local time from UTC, in minutes (e.g. 60 for UTC+1). */
  utcOffsetMinutes: number;
  /** Order of day and month in dotted/slashed dates. ISO dates are always accepted. */
  dateOrder: DateOrder;
  /** Kind of the device named by mapping.deviceId. */
  deviceKind?: DeviceKind;
  deviceVendor?: string;
}

export interface ImportIo {
  writer: ConnectorWriter;
  logger: ConnectorLogger;
  signal: AbortSignal;
}

export interface ImportStats {
  rows: number;
  skippedRows: number;
  skippedObservations: number;
  skippedBindings: number;
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const candidates = (c: ColumnRef) => (Array.isArray(c) ? c : [c]);

/** Finds the header a ColumnRef refers to (case/space-insensitive), or undefined. */
export function resolveColumn(headers: readonly string[], ref: ColumnRef | undefined) {
  if (!ref) return undefined;
  const byNorm = new Map(headers.map((h) => [norm(h), h]));
  for (const c of candidates(ref)) {
    const hit = byNorm.get(norm(c));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  let s = raw.trim().replace(/\s/g, "");
  if (s === "") return undefined;
  if (s.includes(",") && s.includes(".")) {
    // The last separator is the decimal one: 1.234,5 or 1,234.5.
    s =
      s.lastIndexOf(",") > s.lastIndexOf(".")
        ? s.replace(/\./g, "").replace(",", ".")
        : s.replace(/,/g, "");
  } else if (s.includes(",")) s = s.replace(",", ".");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function validDate(y: number, mo: number, d: number): boolean {
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

interface DateParts {
  y: number;
  mo: number;
  d: number;
  h?: number;
  mi?: number;
  s?: number;
  tz?: string;
}

function splitDate(raw: string, order: DateOrder): DateParts | undefined {
  const s = raw.trim();
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(
      s,
    );
  if (iso) {
    return {
      y: Number(iso[1]),
      mo: Number(iso[2]),
      d: Number(iso[3]),
      h: iso[4] === undefined ? undefined : Number(iso[4]),
      mi: iso[5] === undefined ? undefined : Number(iso[5]),
      s: iso[6] === undefined ? 0 : Number(iso[6]),
      tz: iso[7],
    };
  }
  const loose = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(
    s,
  );
  if (loose) {
    const a = Number(loose[1]);
    const b = Number(loose[2]);
    return {
      y: Number(loose[3]),
      mo: order === "dmy" ? b : a,
      d: order === "dmy" ? a : b,
      h: loose[4] === undefined ? undefined : Number(loose[4]),
      mi: loose[5] === undefined ? undefined : Number(loose[5]),
      s: loose[6] === undefined ? 0 : Number(loose[6]),
    };
  }
  return undefined;
}

/** Parses an export date/time into ISO-8601 UTC. Times without an explicit offset use utcOffsetMinutes. */
export function parseTimestamp(
  raw: string,
  order: DateOrder,
  utcOffsetMinutes: number,
): string | undefined {
  const p = splitDate(raw, order);
  if (!p || !validDate(p.y, p.mo, p.d)) return undefined;
  const h = p.h ?? 0;
  const mi = p.mi ?? 0;
  if (h > 23 || mi > 59 || (p.s ?? 0) > 59) return undefined;
  let offset = utcOffsetMinutes;
  if (p.tz) {
    if (p.tz === "Z") offset = 0;
    else {
      const m = /^([+-])(\d{2}):?(\d{2})$/.exec(p.tz);
      if (!m) return undefined;
      offset = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
    }
  }
  const ms = Date.UTC(p.y, p.mo - 1, p.d, h, mi, p.s ?? 0) - offset * 60_000;
  return new Date(ms).toISOString();
}

export function parseDateOnly(raw: string, order: DateOrder): string | undefined {
  const p = splitDate(raw, order);
  if (!p || !validDate(p.y, p.mo, p.d)) return undefined;
  return `${String(p.y).padStart(4, "0")}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

function normSex(raw: string | undefined): AnimalSex | undefined {
  if (!raw) return undefined;
  const s = norm(raw);
  if (["f", "female", "cow", "heifer", "mare", "filly", "w"].includes(s)) return "female";
  if (["m", "male", "bull", "stallion", "colt"].includes(s)) return "male";
  if (["castrated", "gelding", "steer", "ox", "c"].includes(s)) return "castrated";
  return undefined;
}

function normSpecies(raw: string | undefined): Species | undefined {
  if (!raw) return undefined;
  const s = norm(raw);
  if ((SPECIES as readonly string[]).includes(s)) return s as Species;
  if (["cow", "bull", "heifer", "calf", "steer", "ox", "bovine"].includes(s)) return "cattle";
  if (["mare", "stallion", "gelding", "foal", "filly", "colt", "pony", "equine"].includes(s)) {
    return "horse";
  }
  return undefined;
}

const BATCH = 500;

/**
 * Maps every row of a parsed table to animals, devices, wearable bindings and observations.
 * Bad rows are skipped with a warning, never fatal; a missing animal-id column is fatal.
 */
export async function importTable(
  io: ImportIo,
  table: ParsedTable,
  spec: ImportSpec,
): Promise<ImportStats> {
  const { writer, logger } = io;
  const m = spec.mapping;
  const h = table.headers;
  const colAnimal = resolveColumn(h, m.animalId);
  if (colAnimal === undefined) {
    throw new ConnectorParseError(
      `animal id column not found (tried ${candidates(m.animalId).join(", ")}); file columns: ${h.join(", ")}`,
    );
  }
  const col = {
    earTag: resolveColumn(h, m.earTag),
    nationalId: resolveColumn(h, m.nationalId),
    name: resolveColumn(h, m.name),
    breed: resolveColumn(h, m.breed),
    sex: resolveColumn(h, m.sex),
    birthDate: resolveColumn(h, m.birthDate),
    group: resolveColumn(h, m.group),
    species: resolveColumn(h, m.species),
    device: resolveColumn(h, m.deviceId),
    ts: resolveColumn(h, m.timestamp),
    time: resolveColumn(h, m.time),
  };
  const obsCols = (m.observations ?? []).flatMap((o) => {
    const column = resolveColumn(h, o.column);
    if (column === undefined) {
      logger.warn("observation column not in file, skipped", { tried: candidates(o.column) });
      return [];
    }
    return [{ column, map: o }];
  });
  if (obsCols.length > 0 && col.ts === undefined) {
    logger.warn("no timestamp column found: rows produce animals only, no observations", {
      tried: m.timestamp ? candidates(m.timestamp) : [],
    });
  }

  const stats: ImportStats = {
    rows: 0,
    skippedRows: 0,
    skippedObservations: 0,
    skippedBindings: 0,
  };
  const seenAnimals = new Set<string>();
  const seenDevices = new Set<string>();
  const boundPairs = new Set<string>();
  let batch: ObservationInput[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const out = batch;
    batch = [];
    await writer.addObservations(out);
  };
  const get = (row: Record<string, string>, c: string | undefined) => {
    const v = c === undefined ? undefined : row[c];
    return v === undefined || v === "" ? undefined : v;
  };

  for (const [i, row] of table.rows.entries()) {
    io.signal.throwIfAborted();
    stats.rows++;
    const line = i + 2;
    const animalId = get(row, colAnimal);
    if (!animalId) {
      stats.skippedRows++;
      logger.warn("row without animal id skipped", { line });
      continue;
    }
    if (!seenAnimals.has(animalId)) {
      seenAnimals.add(animalId);
      const birthRaw = get(row, col.birthDate);
      const birthDate =
        birthRaw === undefined ? undefined : parseDateOnly(birthRaw, spec.dateOrder);
      if (birthRaw !== undefined && birthDate === undefined) {
        logger.warn("unparseable birth date ignored", { line, value: birthRaw });
      }
      await writer.upsertAnimal({
        externalId: animalId,
        species: normSpecies(get(row, col.species)) ?? spec.defaultSpecies,
        name: get(row, col.name),
        earTagNumber: get(row, col.earTag),
        nationalId: get(row, col.nationalId),
        breed: get(row, col.breed),
        sex: normSex(get(row, col.sex)),
        birthDate,
        groupName: get(row, col.group),
      });
    }

    const deviceId = get(row, col.device);
    if (deviceId !== undefined && spec.deviceKind !== undefined) {
      if (!seenDevices.has(deviceId)) {
        seenDevices.add(deviceId);
        await writer.upsertDevice({
          externalId: deviceId,
          kind: spec.deviceKind,
          vendor: spec.deviceVendor,
          serial: deviceId,
        });
      }
      const pair = `${deviceId}\u0000${animalId}`;
      if (isWearableKind(spec.deviceKind) && !boundPairs.has(pair)) {
        boundPairs.add(pair);
        try {
          await writer.bindDevice({ deviceExternalId: deviceId, animalExternalId: animalId });
        } catch (e) {
          if (!(e instanceof Error) || e.name !== "SingleWearableError") throw e;
          stats.skippedBindings++;
          logger.warn("binding skipped: animal already wears another sensor", {
            line,
            animalId,
            deviceId,
            reason: e.message,
          });
        }
      }
    }

    if (obsCols.length === 0 || col.ts === undefined) continue;
    const dateRaw = get(row, col.ts);
    const timeRaw = get(row, col.time);
    const stamp = dateRaw === undefined ? undefined : timeRaw ? `${dateRaw} ${timeRaw}` : dateRaw;
    const ts =
      stamp === undefined
        ? undefined
        : parseTimestamp(stamp, spec.dateOrder, spec.utcOffsetMinutes);
    if (ts === undefined) {
      stats.skippedObservations += obsCols.length;
      logger.warn("row timestamp missing or unparseable, observations skipped", {
        line,
        value: stamp,
      });
      continue;
    }
    for (const { column, map } of obsCols) {
      const raw = get(row, column);
      if (raw === undefined) continue;
      const n = parseNumber(raw);
      if (n === undefined) {
        stats.skippedObservations++;
        logger.warn("non-numeric value skipped", { line, column, value: raw });
        continue;
      }
      batch.push({
        animalExternalId: animalId,
        deviceExternalId:
          deviceId !== undefined && spec.deviceKind !== undefined ? deviceId : undefined,
        kind: map.kind,
        ts,
        valueNum: n * (map.scale ?? 1),
        valueJson: map.unit ? { unit: map.unit } : undefined,
      });
      if (batch.length >= BATCH) await flush();
    }
  }
  await flush();
  return stats;
}
