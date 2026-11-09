import {
  dailyObservations,
  localDay,
  mapAnimalRow,
  mapMilkingRow,
  type Observation,
} from "./mapping";
import { type Config, createSqlSource, type Source } from "./source";

export type State = {
  readonly lastMilkingOid?: number;
  readonly lastDailyDate?: string;
};

export type Context = {
  readonly connector: {
    readonly id: string;
    readonly name: string | null;
    readonly vendor: string;
    readonly kind: string;
  };
  readonly config: Config;
  readonly secret: string | null;
  readonly state: State | null;
  readonly farmId: string;
  readonly log: (message: string) => void;
};

class MissingSecretError extends Error {
  override readonly name = "MissingSecretError";
}

export default async function sync(ctx: Context) {
  if (ctx.secret === null) {
    throw new MissingSecretError("DelPro SQL password is missing from the OS keychain");
  }
  const source = await createSqlSource(ctx.config, ctx.secret);
  try {
    return await syncWith(source, ctx);
  } finally {
    await source.close();
  }
}

export async function syncWith(source: Source, ctx: Context) {
  const timezone = ctx.config.timezone ?? "UTC";
  const animals = (await source.animals()).map(mapAnimalRow);
  const observations: Observation[] = [];
  let lastMilkingOid = ctx.state?.lastMilkingOid;
  let milkings = 0;
  const limit = ctx.config.milkingBatch ?? 1000;
  for (let batch = 0; batch < (ctx.config.maxBatches ?? 200); batch++) {
    const rows = await source.milkings(lastMilkingOid ?? null, limit);
    for (const row of rows) {
      observations.push(mapMilkingRow(row, timezone));
      lastMilkingOid = Math.max(lastMilkingOid ?? row.oid, row.oid);
    }
    milkings += rows.length;
    if (rows.length < limit) break;
  }
  const today = localDay(timezone, new Date());
  let lastDailyDate = ctx.state?.lastDailyDate;
  let dailyRows = 0;
  for (const row of await source.daily(ctx.config.dailyDays ?? 120)) {
    if (row.date >= today || (ctx.state?.lastDailyDate && row.date <= ctx.state.lastDailyDate)) {
      continue;
    }
    const daily = dailyObservations(row, timezone);
    observations.push(...daily);
    if (daily.length > 0) {
      dailyRows++;
      if (lastDailyDate === undefined || row.date > lastDailyDate) lastDailyDate = row.date;
    }
  }
  const state: State = {
    ...(lastMilkingOid === undefined ? {} : { lastMilkingOid }),
    ...(lastDailyDate === undefined ? {} : { lastDailyDate }),
  };
  ctx.log(`DelPro: ${animals.length} animals, ${milkings} milkings, ${dailyRows} daily rows`);
  return { animals, observations, state };
}
