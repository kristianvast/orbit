// Minimal connector. Copy this folder, rename `id`, then change configSchema, test and sync.
// A connector only READS from the source and writes into Orbit through ctx.writer.
import { readFile } from "node:fs/promises";
import { defineConnector, parseCsv } from "@orbit/connectors";
import { Type } from "typebox";

const configSchema = Type.Object({
  /** Path of the CSV file saved from the vendor software. */
  path: Type.String({ minLength: 1 }),
});

export default defineConnector({
  id: "template_csv",
  vendor: "custom",
  kind: "file_import",
  label: "Template CSV connector",
  configSchema,

  async test(ctx) {
    try {
      const table = await parseCsv(await readFile(ctx.config.path, "utf8"));
      return { ok: true, message: `${table.rows.length} rows` };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  },

  async sync(ctx) {
    const { rows } = parseCsv(await readFile(ctx.config.path, "utf8"));
    for (const row of rows) {
      ctx.signal.throwIfAborted();
      const tag = row.tag;
      if (!tag) continue;
      await ctx.writer.upsertAnimal({
        externalId: tag,
        species: "cattle",
        name: row.name || undefined,
        earTagNumber: tag,
      });
      const weight = Number(row.weight_kg);
      const ts = new Date(row.measured_at ?? "");
      if (Number.isFinite(weight) && !Number.isNaN(ts.getTime())) {
        await ctx.writer.addObservations([
          {
            animalExternalId: tag,
            kind: "weight",
            ts: ts.toISOString(),
            valueNum: weight,
            valueJson: { unit: "kg" },
          },
        ]);
      } else {
        ctx.logger.warn("row skipped: bad weight or date", { tag });
      }
    }
  },
});
