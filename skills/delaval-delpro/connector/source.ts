import type { AnimalRow, DailyRow, MilkingRow } from "./mapping";

export type Config = {
  readonly host: string;
  readonly port?: number;
  readonly database?: string;
  readonly user: string;
  readonly timezone?: string;
  readonly dailyDays?: number;
  readonly milkingBatch?: number;
  readonly maxBatches?: number;
};

export interface Source {
  animals(): Promise<AnimalRow[]>;
  milkings(sinceOid: number | null, limit: number): Promise<MilkingRow[]>;
  daily(days: number): Promise<DailyRow[]>;
  close(): Promise<void>;
}

export const ANIMALS_SQL = `
SELECT
    a.OID AS oid, a.Number AS number, a.OfficialRegNo AS regNo,
    a.Name AS name, CONVERT(varchar(10), a.BirthDate, 23) AS birthDate,
    a.Sex AS sex, CONVERT(varchar(10), a.ExitDate, 23) AS exitDate,
    g.Name AS groupName
FROM BasicAnimal a
LEFT JOIN AbstractGroup g ON g.OID = a.[Group]
WHERE a.OfficialRegNo IS NOT NULL AND a.Number > 0 AND a.GCRecord IS NULL
ORDER BY a.OID`;

export const MILKING_SQL = `
SELECT TOP (@limit)
    s.OID AS oid,
    CONVERT(varchar(19), s.EndTime, 120) AS endTime,
    CONVERT(varchar(19), s.BeginTime, 120) AS beginTime,
    CONVERT(varchar(19), s.PreviousEndTime, 120) AS previousEndTime,
    s.TotalYield AS totalYield, s.AvgConductivity AS avgConductivity,
    s.MilkingDevice AS milkingDevice, s.Destination AS destination,
    v.Occ AS occ, v.OccAverage AS occAverage, v.Incomplete AS incomplete,
    v.Kickoff AS kickoff, v.NotMilkedTeats AS notMilkedTeats, v.Mdi AS mdi,
    v.MilkFlowDuration AS milkFlowDuration, v.MilkType AS milkType,
    a.OfficialRegNo AS regNo, a.Number AS number
FROM SessionMilkYield s
JOIN VoluntarySessionMilkYield v ON v.OID = s.OID
JOIN BasicAnimal a ON a.OID = s.BasicAnimal
WHERE s.OID > @since AND a.OfficialRegNo IS NOT NULL AND a.GCRecord IS NULL
ORDER BY s.OID ASC`;

export const DAILY_SQL = `
SELECT
    a.OfficialRegNo AS regNo, a.Number AS number,
    CONVERT(varchar(10), COALESCE(d.[Date], h.DayDate), 23) AS date,
    COALESCE(d.DIM, h.DIM) AS dim, COALESCE(d.DSLC, h.DSLC) AS dslc,
    COALESCE(d.LactationNumber, h.LactationNumber) AS lactationNumber,
    COALESCE(d.TotalYield, h.DailyYield) AS dailyYield,
    COALESCE(d.AvgYieldPrev7d, h.Last7DayAvg) AS last7DayAvg,
    h.Milkings AS milkings, h.AvgConductivity AS avgConductivity,
    h.AvgCellCount AS avgCellCount, h.AvgFat AS avgFat, h.AvgProtein AS avgProtein,
    h.AvgBCS AS avgBcs, h.AvgWeight AS avgWeight,
    h.AvgRectalTemp AS avgRectalTemp, h.ReproStatus AS reproStatus
FROM (
    SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY BasicAnimal, [Date] ORDER BY OID DESC) AS dayRn
        FROM AnimalDaily
        WHERE GCRecord IS NULL AND [Date] >= DATEADD(day, -@days, CAST(GETDATE() AS date))
    ) dd WHERE dayRn = 1
) d
FULL OUTER JOIN (
    SELECT * FROM HistoryAnimalDailyData
    WHERE DayDate >= DATEADD(day, -@days, CAST(GETDATE() AS date))
) h ON h.Animal = d.BasicAnimal AND CAST(h.DayDate AS date) = d.[Date]
JOIN BasicAnimal a ON a.OID = COALESCE(d.BasicAnimal, h.Animal)
WHERE a.OfficialRegNo IS NOT NULL AND a.GCRecord IS NULL
ORDER BY COALESCE(d.[Date], h.DayDate) ASC`;

interface Request {
  input(name: string, type: unknown, value: number): Request;
  query<T>(text: string): Promise<{ readonly recordset: T[] }>;
}

interface Pool {
  connect(): Promise<Pool>;
  request(): Request;
  close(): Promise<void>;
}

interface SqlDriver {
  readonly Int: unknown;
  readonly ConnectionPool: new (config: {
    readonly server: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password: string;
    readonly connectionTimeout: number;
    readonly requestTimeout: number;
    readonly pool: {
      readonly max: number;
      readonly min: number;
      readonly idleTimeoutMillis: number;
    };
    readonly options: {
      readonly encrypt: boolean;
      readonly trustServerCertificate: boolean;
      readonly enableArithAbort: boolean;
    };
  }) => Pool;
}

class DelproConnectionError extends Error {
  override readonly name = "DelproConnectionError";
}

export async function createSqlSource(config: Config, password: string): Promise<Source> {
  // The payload can be mapped and tested without installing the optional runtime driver.
  const moduleName = "mssql";
  const sql: SqlDriver = await import(moduleName);
  let lastError: unknown;
  for (const encrypt of [false, true]) {
    const pool = new sql.ConnectionPool({
      server: config.host,
      port: config.port ?? 1433,
      database: config.database ?? "DDM",
      user: config.user,
      password,
      connectionTimeout: 15000,
      requestTimeout: 60000,
      pool: { max: 2, min: 0, idleTimeoutMillis: 30000 },
      options: { encrypt, trustServerCertificate: true, enableArithAbort: true },
    });
    try {
      await pool.connect();
    } catch (error) {
      await pool.close();
      if (!(error instanceof Error)) throw error;
      lastError = error;
      continue;
    }
    return {
      animals: async () => (await pool.request().query<AnimalRow>(ANIMALS_SQL)).recordset,
      milkings: async (sinceOid, limit) =>
        (
          await pool
            .request()
            .input("since", sql.Int, sinceOid ?? 0)
            .input("limit", sql.Int, limit)
            .query<MilkingRow>(MILKING_SQL)
        ).recordset,
      daily: async (days) =>
        (await pool.request().input("days", sql.Int, days).query<DailyRow>(DAILY_SQL)).recordset,
      close: () => pool.close(),
    };
  }
  const reason = lastError instanceof Error ? lastError.message : "unknown error";
  throw new DelproConnectionError(
    `Could not connect to DelPro at ${config.host}:${config.port ?? 1433}: ${reason}`,
    { cause: lastError },
  );
}
