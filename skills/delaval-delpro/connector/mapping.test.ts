import { expect, test } from "bun:test";
import {
  type AnimalRow,
  dailyObservations,
  type MilkingRow,
  mapAnimalRow,
  mapDailyRow,
  mapMilkingRow,
  wallClockToUtc,
} from "./mapping";

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
const session: MilkingRow = {
  oid: 3956882,
  number: 876,
  regNo: "250492700876",
  endTime: "2026-06-27 11:27:32",
  beginTime: "2026-06-27 11:20:00",
  previousEndTime: "2026-06-27 06:15:00",
  totalYield: 12.78,
  avgConductivity: 5126,
  milkingDevice: 8,
  occ: 999,
  occAverage: 65.31371307373047,
  destination: 1,
  incomplete: 0,
  kickoff: 0,
  milkType: 0,
};

test("maps animal identity, herd number, and exited status", () => {
  const result = mapAnimalRow({ ...animal, exitDate: "2025-11-30" });
  expect(result).toEqual({
    externalId: "1234",
    species: "cattle",
    nationalId: "250492700876",
    earTagNumber: "876",
    name: "Mona",
    birthDate: "2020-03-15",
    sex: "female",
    groupName: "VMS",
    status: "sold",
  });
});

test.each([
  [2, "female"],
  [1, "male"],
  [0, "unknown"],
  [null, "unknown"],
] as const)("maps DelPro sex %s to %s", (sex, expected) => {
  expect(mapAnimalRow({ ...animal, sex }).sex).toBe(expected);
});

test("keeps present animals active", () => {
  expect(mapAnimalRow(animal).status).toBe("active");
});

test("maps milking kg, scaled conductivity, preferred SCC, seconds, and normal flags", () => {
  expect(mapMilkingRow(session, "UTC")).toEqual({
    nationalId: "250492700876",
    earTag: "876",
    kind: "milking",
    ts: "2026-06-27T11:27:32.000Z",
    valueNum: 12.78,
    valueJson: {
      unit: "kg",
      conductivity: 5.126,
      scc: 65,
      durationSec: 452,
      intervalSec: 18300,
      device: "delpro:8",
      destination: "1",
      incomplete: false,
      kickOff: false,
      discarded: false,
      delproOid: 3956882,
    },
  });
});

test("uses Occ fallback, preserves real conductivity, and flags abnormal milk", () => {
  const result = mapMilkingRow(
    {
      ...session,
      occAverage: null,
      avgConductivity: 4.6,
      destination: 3,
      incomplete: 1,
      kickoff: 1,
    },
    "UTC",
  );
  expect(result.valueJson).toMatchObject({
    scc: 999,
    conductivity: 4.6,
    incomplete: true,
    kickOff: true,
    discarded: true,
  });
});

test("omits null milking metadata while retaining a null yield", () => {
  const result = mapMilkingRow(
    {
      ...session,
      totalYield: null,
      avgConductivity: null,
      occ: null,
      occAverage: null,
      beginTime: null,
      previousEndTime: null,
      milkingDevice: null,
      destination: null,
      milkType: null,
      incomplete: null,
      kickoff: null,
    },
    "UTC",
  );
  expect(result.valueNum).toBeNull();
  expect(result.valueJson).toEqual({ unit: "kg", delproOid: 3956882 });
});

test("treats zero daily weight and rectal temperature as absent", () => {
  const row = {
    regNo: "250492700876",
    number: 876,
    date: "2026-06-27",
    avgWeight: 0,
    avgRectalTemp: 0,
  };
  expect(mapDailyRow(row)).toEqual({ ...row, avgWeight: null, avgRectalTemp: null });
  expect(dailyObservations(row, "UTC")).toEqual([]);
});

test("emits daily sensor values at local midnight with both animal identifiers", () => {
  expect(
    dailyObservations(
      {
        regNo: "250492700876",
        number: 876,
        date: "2026-06-27",
        avgWeight: 641.5,
        avgRectalTemp: 38.7,
      },
      "America/Chicago",
    ),
  ).toEqual([
    {
      nationalId: "250492700876",
      earTag: "876",
      kind: "weight",
      ts: "2026-06-27T05:00:00.000Z",
      valueNum: 641.5,
      valueJson: { unit: "kg" },
    },
    {
      nationalId: "250492700876",
      earTag: "876",
      kind: "temperature",
      ts: "2026-06-27T05:00:00.000Z",
      valueNum: 38.7,
      valueJson: { unit: "C", site: "rectal" },
    },
  ]);
});

test.each([
  ["2026-03-29 01:30:00", "Europe/Oslo", "2026-03-29T00:30:00.000Z"],
  ["2026-03-29 03:30:00", "Europe/Oslo", "2026-03-29T01:30:00.000Z"],
  ["2026-03-08 01:30:00", "America/Chicago", "2026-03-08T07:30:00.000Z"],
  ["2026-03-08 03:30:00", "America/Chicago", "2026-03-08T08:30:00.000Z"],
  ["2026-11-01 01:30:00", "America/Chicago", "2026-11-01T06:30:00.000Z"],
  ["2026-10-25 02:30:00", "Europe/Oslo", "2026-10-25T00:30:00.000Z"],
] as const)("converts %s in %s across DST", (local, timezone, expected) => {
  expect(wallClockToUtc(local, timezone)).toBe(expected);
});

test("rejects nonexistent DST wall-clock times", () => {
  expect(() => wallClockToUtc("2026-03-29 02:30:00", "Europe/Oslo")).toThrow("does not exist");
});
