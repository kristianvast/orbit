# @orbit/connectors

Connectors import data from milking robots, herd software and wearable sensors into Orbit. They are **read-only** toward the vendor: they read an export or an API and write into Orbit through a typed writer. Nothing here can change a robot, a herd package or a sensor.

## How a farmer's agent builds a connector

1. **Look at the real data first.** Ask the farmer to save an export (CSV or XML) from the vendor software and open it. Note the delimiter, header names, date format, decimal separator and units.
2. **Try `generic_csv` before writing code.** It maps columns to animals, devices and observations through config only:

   ```json
   {
     "path": "C:/export/animals.csv",
     "deviceKind": "collar",
     "dateOrder": "dmy",
     "utcOffsetMinutes": 60,
     "mapping": {
       "animalId": "Cow",
       "earTag": "Tag",
       "deviceId": "Collar",
       "timestamp": "Measured",
       "observations": [{ "column": "Weight", "kind": "weight", "unit": "kg" }]
     }
   }
   ```

   A column can be one header or a list of candidates (first one present wins). Decimal commas, `;`/tab delimiters, a BOM, ISO and `dd.mm.yyyy` dates and a separate `time` column are handled.
3. **If the config cannot express it, copy `template/`** (Orion's `connector_scaffold` does this), rename the `id`, and edit `index.ts`. Keep `fixture.csv` as a real, anonymised sample and make `index.test.ts` assert what the sync must write.
4. **Run `bun test` and `tsc --noEmit`.** Enable the connector only when both pass, then run its `test()` against the farmer's real file.

## SDK

```ts
import { defineConnector, createMemoryWriter, runSync } from "@orbit/connectors";

export default defineConnector({
  id: "my_feed",
  vendor: "custom", // an entry of CONNECTOR_VENDORS
  kind: "file_import", // milking_robot | herd_software | wearable | camera | file_import
  configSchema, // typebox schema; non-secret settings only
  async test(ctx) {}, // returns { ok, message }; cheap, no side effects
  async sync(ctx) {}, // writes through ctx.writer
});
```

`ctx` has `config` (validated), `writer`, `logger`, `signal` (an `AbortSignal`: stop promptly) and `connectorId`.

`ctx.writer`: `upsertAnimal`, `upsertDevice`, `bindDevice`, `addObservations`. Rows are addressed by the vendor's own id (`externalId`), so re-running a sync updates instead of duplicating. Upsert animals and devices before referencing them.

Domain rule: an animal wears a collar **or** a bolus **or** an ear tag, never several. `bindDevice` throws `SingleWearableError` for a second one. The built-in file importers catch it, log a warning and keep going.

Use `createMemoryWriter()` in tests and `runSync` / `runTest` to run a connector the way the host does (config validation, write counts).

## Built-in adapters

| id            | vendor      | status  |
| ------------- | ----------- | ------- |
| `generic_csv` | generic_csv | working |

Vendor-specific adapters are added only once they are built against a real provider connection or a verified export from that vendor; guessed layouts are not shipped. `mode: "api"` is reserved and throws `NotImplementedError`.

## Rules for connector code

- Read only. Never write back to the vendor system.
- No secrets in config. Reference the OS keychain by key.
- Skip bad rows with `ctx.logger.warn`; fail only on a missing required column or unreadable source.
- Times are stored as ISO-8601 UTC. Pass `utcOffsetMinutes` when the export is in local time.
