---

name: connectors
description: Connect Orbit to milking robots, sensor clouds, CSV exports or custom systems. Use when the farmer wants data from a vendor system or a file imported.
---

# Connectors

1. `connectors_list` shows existing connectors, whether they are on, and the last error.
2. For a named vendor system (a robot, herd program or sensor brand), `skill_search` the vendor
   first. If a skill exists, `skill_install` it and follow its instructions instead of the steps below.
3. For a new source, `connector_scaffold` with a short name (e.g. `barn-scale-csv`). It creates
   `connectors/<name>/` in the workspace and registers it switched off.
4. Edit `connectors/<name>/connector.ts`. It exports `default async function sync(ctx)` and
   returns `{ observations: [{ earTag | animalId, kind, ts, valueNum }] }`. `ctx.config` holds
   non-secret settings and `ctx.secret` the stored secret; `ctx.log()` writes to the run log.
5. Ask the farmer to switch it on in Settings > Connectors, then `connector_run` once and report
   how many readings were imported.

Rules
- Ask for exports or local APIs before cloud scraping. Prefer read-only access to vendor systems.
- Never write secrets into files. Ask the farmer to enter the password in Sensors & Robots >
  Connections (Password); non-secret settings go through `connector_configure`.
- Keep connectors small and readable; add a short README explaining where the data comes from.
