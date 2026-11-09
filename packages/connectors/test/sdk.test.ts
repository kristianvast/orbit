import { describe, expect, test } from "bun:test";
import { SingleWearableError } from "@orbit/schema";
import { Type } from "typebox";
import {
  builtinConnectors,
  ConnectorConfigError,
  ConnectorWriteError,
  createMemoryWriter,
  defineConnector,
  getConnector,
  NotImplementedError,
  runSync,
  runTest,
} from "../src";

describe("defineConnector", () => {
  const c = defineConnector({
    id: "demo",
    vendor: "custom",
    kind: "file_import",
    configSchema: Type.Object({ path: Type.String() }),
    async test() {
      return { ok: true, message: "fine" };
    },
    async sync(ctx) {
      await ctx.writer.upsertAnimal({ externalId: ctx.config.path, species: "horse" });
    },
  });

  test("validates config and reports every issue", () => {
    expect(c.parseConfig({ path: "x" })).toEqual({ path: "x" });
    expect(() => c.parseConfig({ path: 3 })).toThrow(ConnectorConfigError);
    expect(() => c.parseConfig(null)).toThrow(ConnectorConfigError);
  });

  test("runSync counts writes and runTest returns the result", async () => {
    const writer = createMemoryWriter();
    expect(await runSync(c, { rawConfig: { path: "h1" }, writer })).toEqual({
      animals: 1,
      devices: 0,
      bindings: 0,
      observations: 0,
    });
    expect(writer.animals.get("h1")?.species).toBe("horse");
    expect(await runTest(c, { rawConfig: { path: "h1" }, writer })).toEqual({
      ok: true,
      message: "fine",
    });
  });
});

describe("memory writer", () => {
  async function seeded() {
    const w = createMemoryWriter(() => "2026-10-01T00:00:00.000Z");
    await w.upsertAnimal({ externalId: "a1", species: "cattle" });
    await w.upsertAnimal({ externalId: "a2", species: "cattle" });
    await w.upsertDevice({ externalId: "collar1", kind: "collar" });
    await w.upsertDevice({ externalId: "bolus1", kind: "bolus" });
    await w.upsertDevice({ externalId: "robot1", kind: "milking_robot" });
    return w;
  }

  test("an animal never gets a second active wearable", async () => {
    const w = await seeded();
    await w.bindDevice({ deviceExternalId: "collar1", animalExternalId: "a1" });
    await expect(
      w.bindDevice({ deviceExternalId: "bolus1", animalExternalId: "a1" }),
    ).rejects.toBeInstanceOf(SingleWearableError);
    expect(w.activeBindings()).toHaveLength(1);
  });

  test("non-wearables are not limited and rebinding is idempotent", async () => {
    const w = await seeded();
    await w.bindDevice({ deviceExternalId: "collar1", animalExternalId: "a1" });
    await w.bindDevice({ deviceExternalId: "robot1", animalExternalId: "a1" });
    await w.bindDevice({ deviceExternalId: "collar1", animalExternalId: "a1" });
    expect(w.activeBindings()).toHaveLength(2);
  });

  test("moving a device ends its previous binding", async () => {
    const w = await seeded();
    await w.bindDevice({ deviceExternalId: "collar1", animalExternalId: "a1" });
    await w.bindDevice({ deviceExternalId: "collar1", animalExternalId: "a2" });
    expect(w.activeBindings().map((b) => b.animalExternalId)).toEqual(["a2"]);
  });

  test("rejects references to unknown animals and devices", async () => {
    const w = await seeded();
    await expect(
      w.addObservations([{ animalExternalId: "zz", kind: "weight", ts: "2026-10-01T00:00:00Z" }]),
    ).rejects.toBeInstanceOf(ConnectorWriteError);
    await expect(
      w.bindDevice({ deviceExternalId: "nope", animalExternalId: "a1" }),
    ).rejects.toBeInstanceOf(ConnectorWriteError);
  });
});

describe("builtin connectors", () => {
  test("registry exposes only the generic CSV importer", () => {
    expect(builtinConnectors.map((c) => c.id)).toEqual(["generic_csv"]);
    expect(getConnector("generic_csv")?.vendor).toBe("generic_csv");
    expect(getConnector("unknown")).toBeUndefined();
  });

  test("every adapter's API path throws NotImplementedError", async () => {
    for (const c of builtinConnectors) {
      const opts = { rawConfig: { mode: "api" }, writer: createMemoryWriter() };
      await expect(runSync(c, opts)).rejects.toBeInstanceOf(NotImplementedError);
      await expect(runTest(c, opts)).rejects.toBeInstanceOf(NotImplementedError);
    }
  });

  test("sync stops when the signal is aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      runSync(getConnector("generic_csv") as never, {
        rawConfig: {
          path: new URL("./fixtures/generic.csv", import.meta.url).pathname,
          mapping: { animalId: "Cow" },
        },
        writer: createMemoryWriter(),
        signal: ac.signal,
      }),
    ).rejects.toThrow();
  });
});
