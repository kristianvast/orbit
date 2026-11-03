# Template connector

A connector copies data from a vendor system into Orbit. It never writes back to the vendor.

1. Copy this folder and rename it after the source (for example `my_feed`).
2. In `index.ts` change `id`, `vendor` (use `custom` if the vendor is not in the enum), `kind` and `configSchema`.
3. Replace the parsing in `sync` with your source's format. Call `ctx.writer.upsertAnimal`, `upsertDevice`, `bindDevice` and `addObservations`; refer to rows by the vendor's own id (`externalId`).
4. Put a real (anonymised) sample from the source in `fixture.csv` and make `index.test.ts` assert what the sync should produce.
5. Run `bun test` and `tsc --noEmit` in the folder. Both must pass before the connector is enabled.

Rules: one wearable per animal (a collar OR a bolus OR an ear tag; `bindDevice` throws `SingleWearableError` for a second one), no secrets in config (use a keychain reference), stop on `ctx.signal`, and log skipped rows with `ctx.logger.warn` rather than failing the whole import.
