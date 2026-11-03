import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createMemoryWriter, runSync, runTest } from "@orbit/connectors";
import connector from "./index";

const path = join(import.meta.dir, "fixture.csv");

describe("template connector", () => {
  test("test() reads the fixture", async () => {
    const r = await runTest(connector, { rawConfig: { path }, writer: createMemoryWriter() });
    expect(r).toEqual({ ok: true, message: "2 rows" });
  });

  test("test() reports a missing file instead of throwing", async () => {
    const r = await runTest(connector, {
      rawConfig: { path: join(import.meta.dir, "nope.csv") },
      writer: createMemoryWriter(),
    });
    expect(r.ok).toBe(false);
  });

  test("sync() writes animals and weight observations", async () => {
    const writer = createMemoryWriter();
    const counts = await runSync(connector, { rawConfig: { path }, writer });
    expect(counts).toEqual({ animals: 2, devices: 0, bindings: 0, observations: 2 });
    expect(writer.animals.get("A-1001")?.name).toBe("Bella");
    expect(writer.observations[0]).toMatchObject({
      kind: "weight",
      ts: "2026-10-01T06:30:00.000Z",
      valueNum: 612.5,
    });
  });
});
