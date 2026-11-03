import { describe, expect, test } from "bun:test";
import {
  ConnectorConfigError,
  ConnectorParseError,
  createMemoryWriter,
  genericCsvConnector,
  parseNumber,
  parseTimestamp,
  runSync,
  runTest,
} from "../src";
import { collectingLogger, fixture } from "./helpers";

const config = {
  path: fixture("generic.csv"),
  deviceKind: "collar",
  mapping: {
    animalId: "Cow",
    earTag: "Tag",
    name: "Name",
    birthDate: "Born",
    sex: "Sex",
    group: "Group",
    deviceId: "Collar",
    timestamp: "Measured",
    observations: [{ column: "Weight", kind: "weight", unit: "kg" }],
  },
};

describe("generic_csv", () => {
  test("maps columns to animals, a bound collar and observations", async () => {
    const writer = createMemoryWriter();
    const { logger, warnings } = collectingLogger();
    const counts = await runSync(genericCsvConnector, { rawConfig: config, writer, logger });

    expect(counts).toEqual({ animals: 3, devices: 2, bindings: 2, observations: 2 });
    expect(writer.animals.get("1001")).toMatchObject({
      species: "cattle",
      name: "Bella",
      earTagNumber: "A-1001",
      birthDate: "2021-03-04",
      sex: "female",
      groupName: "Milking",
    });
    expect(writer.animals.get("1002")?.birthDate).toBe("2020-05-04");
    expect(writer.devices.get("C-77")).toMatchObject({ kind: "collar", serial: "C-77" });
    expect(writer.observations[0]).toEqual({
      animalExternalId: "1001",
      deviceExternalId: "C-77",
      kind: "weight",
      ts: "2026-10-01T06:30:00.000Z",
      valueNum: 612.5,
      valueJson: { unit: "kg" },
    });
    expect(warnings.map((w) => w.message)).toEqual([
      "non-numeric value skipped",
      "row without animal id skipped",
    ]);
  });

  test("utcOffsetMinutes shifts local export times to UTC", async () => {
    const writer = createMemoryWriter();
    await runSync(genericCsvConnector, {
      rawConfig: { ...config, utcOffsetMinutes: 120 },
      writer,
    });
    expect(writer.observations[0]?.ts).toBe("2026-10-01T04:30:00.000Z");
  });

  test("a second sensor for the same animal is skipped with a warning", async () => {
    const writer = createMemoryWriter();
    const { logger, warnings } = collectingLogger();
    const counts = await runSync(genericCsvConnector, {
      rawConfig: {
        path: fixture("generic-conflict.csv"),
        deviceKind: "collar",
        mapping: {
          animalId: "Cow",
          deviceId: "Collar",
          timestamp: "Measured",
          observations: [{ column: "Weight", kind: "weight" }],
        },
      },
      writer,
      logger,
    });
    expect(counts.bindings).toBe(1);
    expect(writer.activeBindings().map((b) => b.deviceExternalId)).toEqual(["C-1"]);
    expect(warnings.some((w) => w.message.startsWith("binding skipped"))).toBe(true);
  });

  test("scale converts units", async () => {
    const writer = createMemoryWriter();
    await runSync(genericCsvConnector, {
      rawConfig: {
        ...config,
        mapping: {
          ...config.mapping,
          observations: [{ column: "Weight", kind: "weight", scale: 0.5 }],
        },
      },
      writer,
    });
    expect(writer.observations[0]?.valueNum).toBe(306.25);
  });

  test("test() lists columns, and flags a wrong mapping", async () => {
    const ok = await runTest(genericCsvConnector, {
      rawConfig: config,
      writer: createMemoryWriter(),
    });
    expect(ok.ok).toBe(true);
    expect(ok.message).toContain("4 rows");
    const bad = await runTest(genericCsvConnector, {
      rawConfig: { ...config, mapping: { animalId: "Missing" } },
      writer: createMemoryWriter(),
    });
    expect(bad.ok).toBe(false);
    const gone = await runTest(genericCsvConnector, {
      rawConfig: { ...config, path: fixture("absent.csv") },
      writer: createMemoryWriter(),
    });
    expect(gone.ok).toBe(false);
  });

  test("a missing animal id column makes sync fail, a missing mapping is a config error", async () => {
    await expect(
      runSync(genericCsvConnector, {
        rawConfig: { ...config, mapping: { animalId: "Missing" } },
        writer: createMemoryWriter(),
      }),
    ).rejects.toBeInstanceOf(ConnectorParseError);
    await expect(
      runSync(genericCsvConnector, {
        rawConfig: { path: config.path },
        writer: createMemoryWriter(),
      }),
    ).rejects.toBeInstanceOf(ConnectorConfigError);
    await expect(
      runSync(genericCsvConnector, {
        rawConfig: { path: 5 },
        writer: createMemoryWriter(),
      }),
    ).rejects.toBeInstanceOf(ConnectorConfigError);
  });
});

describe("value parsing", () => {
  test("numbers accept decimal comma and thousands separators", () => {
    expect(parseNumber("612,5")).toBe(612.5);
    expect(parseNumber("1.234,5")).toBe(1234.5);
    expect(parseNumber("1,234.5")).toBe(1234.5);
    expect(parseNumber("abc")).toBeUndefined();
    expect(parseNumber("")).toBeUndefined();
  });

  test("timestamps: ISO, offsets, dmy, mdy and invalid dates", () => {
    expect(parseTimestamp("2026-10-01T06:30:00+02:00", "dmy", 0)).toBe("2026-10-01T04:30:00.000Z");
    expect(parseTimestamp("01.10.2026 05:12", "dmy", 0)).toBe("2026-10-01T05:12:00.000Z");
    expect(parseTimestamp("10/01/2026 05:12", "mdy", 0)).toBe("2026-10-01T05:12:00.000Z");
    expect(parseTimestamp("31.02.2026", "dmy", 0)).toBeUndefined();
    expect(parseTimestamp("garbage", "dmy", 0)).toBeUndefined();
  });
});
