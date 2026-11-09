export type AnimalRow = {
  readonly oid: number;
  readonly number: number;
  readonly regNo: string;
  readonly name: string | null;
  readonly birthDate: string | null;
  readonly sex: number | null;
  readonly groupName: string | null;
  readonly exitDate: string | null;
};

export type MilkingRow = {
  readonly oid: number;
  readonly number: number;
  readonly regNo: string;
  readonly endTime: string;
  readonly beginTime: string | null;
  readonly previousEndTime: string | null;
  readonly totalYield: number | null;
  readonly avgConductivity: number | null;
  readonly occ: number | null;
  readonly occAverage: number | null;
  readonly milkingDevice: number | null;
  readonly destination: number | null;
  readonly milkType: number | null;
  readonly incomplete: number | null;
  readonly kickoff: number | null;
};

export type DailyRow = {
  readonly regNo: string;
  readonly number: number;
  readonly date: string;
  readonly avgWeight: number | null;
  readonly avgRectalTemp: number | null;
};

export type Observation = {
  readonly nationalId: string | null;
  readonly earTag: string | null;
  readonly kind: "milking" | "weight" | "temperature";
  readonly ts: string;
  readonly valueNum: number | null;
  readonly valueJson: Record<string, unknown> | null;
};

export function mapAnimalRow(row: AnimalRow) {
  return {
    externalId: String(row.oid),
    species: "cattle" as const,
    nationalId: row.regNo,
    earTagNumber: String(row.number),
    name: row.name,
    birthDate: row.birthDate,
    sex:
      row.sex === 2
        ? ("female" as const)
        : row.sex === 1
          ? ("male" as const)
          : ("unknown" as const),
    groupName: row.groupName,
    status: row.exitDate === null ? ("active" as const) : ("sold" as const),
  };
}

function wallClock(date: Date, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export function localDay(timezone: string, date: Date): string {
  return wallClock(date, timezone).slice(0, 10);
}

class WallClockError extends Error {
  override readonly name = "WallClockError";
}

// Overlap: choose the earlier occurrence. A nonexistent spring-forward time is rejected.
export function wallClockToUtc(local: string, timezone: string): string {
  const normalized = local.replace(" ", "T");
  const nominal = Date.parse(`${normalized}Z`);
  const candidates = [-36, 0, 36]
    .map((hours) => {
      const sample = nominal + hours * 3_600_000;
      const offset = Date.parse(`${wallClock(new Date(sample), timezone)}Z`) - sample;
      return nominal - offset;
    })
    .filter((candidate) => wallClock(new Date(candidate), timezone) === normalized);
  if (candidates.length === 0) {
    throw new WallClockError(`DelPro wall-clock time ${local} does not exist in ${timezone}`);
  }
  return new Date(Math.min(...candidates)).toISOString();
}

function seconds(begin: string | null, end: string): number | null {
  if (begin === null) return null;
  return Math.round(
    (Date.parse(`${end.replace(" ", "T")}Z`) - Date.parse(`${begin.replace(" ", "T")}Z`)) / 1000,
  );
}

export function mapMilkingRow(row: MilkingRow, timezone: string): Observation {
  const scc = row.occAverage ?? row.occ;
  const values = {
    unit: "kg",
    conductivity:
      row.avgConductivity === null
        ? null
        : row.avgConductivity > 100
          ? row.avgConductivity / 1000
          : row.avgConductivity,
    scc: scc === null ? null : Math.round(scc),
    durationSec: seconds(row.beginTime, row.endTime),
    intervalSec: seconds(row.previousEndTime, row.beginTime ?? row.endTime),
    device: row.milkingDevice === null ? null : `delpro:${row.milkingDevice}`,
    destination: row.destination === null ? null : String(row.destination),
    incomplete: row.incomplete === null ? null : row.incomplete !== 0,
    kickOff: row.kickoff === null ? null : row.kickoff !== 0,
    discarded:
      row.destination === null && row.milkType === null
        ? null
        : (row.destination !== null && row.destination !== 1) ||
          (row.milkType !== null && row.milkType !== 0),
    delproOid: row.oid,
  };
  return {
    nationalId: row.regNo,
    earTag: String(row.number),
    kind: "milking",
    ts: wallClockToUtc(row.endTime, timezone),
    valueNum: row.totalYield,
    valueJson: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null)),
  };
}

export function mapDailyRow(row: DailyRow) {
  return {
    ...row,
    avgWeight: row.avgWeight === 0 ? null : row.avgWeight,
    avgRectalTemp: row.avgRectalTemp === 0 ? null : row.avgRectalTemp,
  };
}

export function dailyObservations(row: DailyRow, timezone: string): Observation[] {
  const mapped = mapDailyRow(row);
  const ts = wallClockToUtc(`${row.date}T00:00:00`, timezone);
  const observations: Observation[] = [];
  if (mapped.avgWeight !== null) {
    observations.push({
      nationalId: row.regNo,
      earTag: String(row.number),
      kind: "weight",
      ts,
      valueNum: mapped.avgWeight,
      valueJson: { unit: "kg" },
    });
  }
  if (mapped.avgRectalTemp !== null) {
    observations.push({
      nationalId: row.regNo,
      earTag: String(row.number),
      kind: "temperature",
      ts,
      valueNum: mapped.avgRectalTemp,
      valueJson: { unit: "C", site: "rectal" },
    });
  }
  return observations;
}
