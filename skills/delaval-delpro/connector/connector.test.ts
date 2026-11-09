import { afterEach, expect, setSystemTime, test } from "bun:test";
import sync, { type Context, syncWith } from "./connector";
import type { AnimalRow, DailyRow, MilkingRow } from "./mapping";
import type { Source } from "./source";

const animal: AnimalRow = {
  oid: 1234,
  number: 876,
  regNo: "250492700876",
  name: "Mona",
  birthDate: "2020-03-15",
  sex: 2,
  groupName: "VMS",
  exitDate: null,
};
const milking: MilkingRow = {
  oid: 3956882,
  number: 876,
  regNo: animal.regNo,
  endTime: "2026-06-27 11:27:32",
  beginTime: "2026-06-27 11:20:00",
  previousEndTime: "2026-06-27 06:15:00",
  totalYield: 12.78,
  avgConductivity: 4.6,
  milkingDevice: 8,
  occ: null,
  occAverage: 50,
  destination: 1,
  incomplete: 0,
  kickoff: 0,
  milkType: 0,
};
const daily: DailyRow = {
  regNo: animal.regNo,
  number: animal.number,
  date: "2026-06-27",
  avgWeight: 641.5,
  avgRectalTemp: 38.7,
};

class MemorySource implements Source {
  constructor(
    readonly sessions: readonly MilkingRow[] = [milking, { ...milking, oid: 3956883 }],
    readonly days: readonly DailyRow[] = [daily],
  ) {}
  async animals() {
    return [animal];
  }
  async milkings(since: number | null, limit: number) {
    return this.sessions.filter((row) => row.oid > (since ?? 0)).slice(0, limit);
  }
  async daily() {
    return [...this.days];
  }
  async close() {}
}

function context(): Context {
  return {
    connector: { id: "connector", name: null, vendor: "delaval", kind: "delpro" },
    config: { host: "localhost", user: "reader", timezone: "America/Chicago", milkingBatch: 1 },
    secret: "test-only",
    state: null,
    farmId: "farm",
    log: () => {},
  };
}

afterEach(() => setSystemTime());

test("first run imports animals, paginated milkings, daily sensors, and cursors", async () => {
  setSystemTime(new Date("2026-06-28T12:00:00Z"));
  const logs: string[] = [];
  const result = await syncWith(new MemorySource(), {
    ...context(),
    log: (line) => logs.push(line),
  });
  expect(result.animals).toEqual([
    {
      externalId: "1234",
      species: "cattle",
      nationalId: animal.regNo,
      earTagNumber: "876",
      name: "Mona",
      birthDate: "2020-03-15",
      sex: "female",
      groupName: "VMS",
      status: "active",
    },
  ]);
  expect(result.observations.map(({ kind, ts, valueNum }) => ({ kind, ts, valueNum }))).toEqual([
    { kind: "milking", ts: "2026-06-27T16:27:32.000Z", valueNum: 12.78 },
    { kind: "milking", ts: "2026-06-27T16:27:32.000Z", valueNum: 12.78 },
    { kind: "weight", ts: "2026-06-27T05:00:00.000Z", valueNum: 641.5 },
    { kind: "temperature", ts: "2026-06-27T05:00:00.000Z", valueNum: 38.7 },
  ]);
  expect(result.state).toEqual({ lastMilkingOid: 3956883, lastDailyDate: "2026-06-27" });
  expect(logs).toEqual(["DelPro: 1 animals, 2 milkings, 1 daily rows"]);
});

test("second run with returned state emits no repeated milkings or daily observations", async () => {
  setSystemTime(new Date("2026-06-28T12:00:00Z"));
  const source = new MemorySource();
  const first = await syncWith(source, context());
  const second = await syncWith(source, { ...context(), state: first.state });
  expect(second.observations).toEqual([]);
  expect(second.state).toEqual(first.state);
});

test("imports only completed local days strictly after the previous cursor", async () => {
  setSystemTime(new Date("2026-06-29T02:00:00Z")); // Still June 28 in Chicago.
  const source = new MemorySource(
    [],
    [
      { ...daily, date: "2026-06-26" },
      daily,
      { ...daily, date: "2026-06-28" },
      { ...daily, date: "2026-06-29" },
      { ...daily, date: "2026-06-27", avgWeight: 0, avgRectalTemp: 0 },
    ],
  );
  const result = await syncWith(source, {
    ...context(),
    state: { lastDailyDate: "2026-06-26" },
  });
  expect(result.observations.map((row) => [row.kind, row.ts])).toEqual([
    ["weight", "2026-06-27T05:00:00.000Z"],
    ["temperature", "2026-06-27T05:00:00.000Z"],
  ]);
  expect(result.state).toEqual({ lastDailyDate: "2026-06-27" });
});

test("stops at the configured batch cap and preserves the daily cursor without values", async () => {
  setSystemTime(new Date("2026-06-28T12:00:00Z"));
  const ctx = context();
  const result = await syncWith(new MemorySource(undefined, []), {
    ...ctx,
    config: { ...ctx.config, maxBatches: 1 },
    state: { lastDailyDate: "2026-06-26" },
  });
  expect(result.observations.map((row) => row.valueJson?.delproOid)).toEqual([3956882]);
  expect(result.state).toEqual({ lastMilkingOid: 3956882, lastDailyDate: "2026-06-26" });
});

test("null secret fails before loading the SQL driver or opening a connection", async () => {
  await expect(sync({ ...context(), secret: null })).rejects.toThrow(
    "DelPro SQL password is missing from the OS keychain",
  );
});
