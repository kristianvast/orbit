import { describe, expect, test } from "bun:test";
import {
  allflexConnector,
  ConnectorConfigError,
  cowmanagerConnector,
  createMemoryWriter,
  delproConnector,
  lelyT4cConnector,
  runSync,
  smaxtecConnector,
} from "../src";
import { fixture } from "./helpers";

describe("lely_t4c file export", () => {
  test("imports milkings against the robot", async () => {
    const writer = createMemoryWriter();
    const counts = await runSync(lelyT4cConnector, {
      rawConfig: { path: fixture("lely.csv") },
      writer,
    });
    expect(counts).toEqual({ animals: 2, devices: 2, bindings: 0, observations: 3 });
    expect(writer.devices.get("Robot 1")?.kind).toBe("milking_robot");
    expect(writer.animals.get("1001")).toMatchObject({
      earTagNumber: "A-1001",
      birthDate: "2021-03-04",
    });
    expect(writer.observations[0]).toMatchObject({
      kind: "milking",
      deviceExternalId: "Robot 1",
      ts: "2026-10-01T05:12:00.000Z",
      valueNum: 14.2,
    });
  });

  test("config.mapping overrides an unconfirmed default header", async () => {
    const writer = createMemoryWriter();
    await runSync(lelyT4cConnector, {
      rawConfig: { path: fixture("lely.csv"), mapping: { animalId: "Ear tag" } },
      writer,
    });
    expect([...writer.animals.keys()]).toEqual(["A-1001", "A-1002"]);
  });
});

describe("delpro file export", () => {
  test("csv with split date and time and decimal commas", async () => {
    const writer = createMemoryWriter();
    const counts = await runSync(delproConnector, {
      rawConfig: { path: fixture("delpro.csv") },
      writer,
    });
    expect(counts).toEqual({ animals: 2, devices: 2, bindings: 0, observations: 2 });
    expect(writer.observations[0]).toMatchObject({
      kind: "milking",
      ts: "2026-10-01T05:12:00.000Z",
      valueNum: 14.2,
    });
  });

  test("xml with attributes and child elements", async () => {
    const writer = createMemoryWriter();
    const counts = await runSync(delproConnector, {
      rawConfig: { path: fixture("delpro.xml"), format: "xml" },
      writer,
    });
    expect(counts).toEqual({ animals: 2, devices: 2, bindings: 0, observations: 2 });
    expect(writer.animals.get("1001")?.name).toBe("Bella & Co");
    expect(writer.observations.map((o) => o.valueNum)).toEqual([14.2, 16]);
  });
});

describe("smaxtec bolus file export", () => {
  test("binds one bolus per animal and imports three metrics", async () => {
    const writer = createMemoryWriter();
    const counts = await runSync(smaxtecConnector, {
      rawConfig: { path: fixture("smaxtec.csv") },
      writer,
    });
    expect(counts).toEqual({ animals: 2, devices: 2, bindings: 2, observations: 9 });
    expect(writer.devices.get("BOL-1")).toMatchObject({ kind: "bolus", vendor: "smaxtec" });
    expect(writer.observations.find((o) => o.kind === "temperature")?.valueNum).toBe(38.6);
  });
});

describe("cowmanager ear tag file export", () => {
  test("imports rumination and activity from ear tags", async () => {
    const writer = createMemoryWriter();
    const counts = await runSync(cowmanagerConnector, {
      rawConfig: { path: fixture("cowmanager.csv") },
      writer,
    });
    expect(counts).toEqual({ animals: 2, devices: 2, bindings: 2, observations: 4 });
    expect(writer.devices.get("TAG-1")?.kind).toBe("ear_tag_sensor");
    expect(writer.observations.find((o) => o.kind === "rumination")?.valueNum).toBe(28);
  });
});

describe("allflex file export", () => {
  test("defaults to collar and allows ear_tag_sensor", async () => {
    const collar = createMemoryWriter();
    const counts = await runSync(allflexConnector, {
      rawConfig: { path: fixture("allflex.csv") },
      writer: collar,
    });
    expect(counts).toEqual({ animals: 2, devices: 2, bindings: 2, observations: 4 });
    expect(collar.devices.get("COL-1")?.kind).toBe("collar");

    const tag = createMemoryWriter();
    await runSync(allflexConnector, {
      rawConfig: { path: fixture("allflex.csv"), deviceKind: "ear_tag_sensor" },
      writer: tag,
    });
    expect(tag.devices.get("COL-1")?.kind).toBe("ear_tag_sensor");
  });

  test("rejects a bolus: Allflex does not make one", async () => {
    await expect(
      runSync(allflexConnector, {
        rawConfig: { path: fixture("allflex.csv"), deviceKind: "bolus" },
        writer: createMemoryWriter(),
      }),
    ).rejects.toBeInstanceOf(ConnectorConfigError);
  });
});

describe("one wearable per animal across vendors", () => {
  test("a cow already wearing a bolus does not also get an ear tag", async () => {
    const writer = createMemoryWriter();
    await runSync(smaxtecConnector, { rawConfig: { path: fixture("smaxtec.csv") }, writer });
    const counts = await runSync(cowmanagerConnector, {
      rawConfig: { path: fixture("cowmanager.csv") },
      writer,
    });
    expect(counts.bindings).toBe(0);
    expect(
      writer
        .activeBindings()
        .map((b) => b.deviceExternalId)
        .sort(),
    ).toEqual(["BOL-1", "BOL-2"]);
  });
});
