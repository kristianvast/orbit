---

name: connectors
description: Connect Orbit to milking robots, sensor clouds, CSV exports or custom systems. Use when the farmer wants data from a vendor system or a file imported.
---

# Connectors

Orbit ships no ready sensor connection. For sensors or other unvalidated equipment, build the
connection from scratch with the farmer and test it against the real device before showing its
data or controls in the app. Never tell the farmer to add a sensor in a screen.

1. `connectors_list` shows existing connectors, whether they are on, and the last error.
2. For a named vendor system (a robot, herd program or sensor brand), `skill_search` the vendor
   first. If a validated connector skill exists, `skill_install` it and follow its instructions
   instead of the steps below. Do not treat a search result alone as proof that equipment works.
3. For a new source, `connector_scaffold` with a short name (e.g. `barn-scale-csv`). It creates
   `connectors/<name>/` in the workspace and registers it switched off.
4. Edit `connectors/<name>/connector.ts`. It exports `default async function sync(ctx)` and
   returns `{ observations: [{ earTag | animalId, kind, ts, valueNum }] }`. `ctx.config` holds
   non-secret settings and `ctx.secret` the stored secret; `ctx.log()` writes to the run log.
5. With the farmer's yes to contact the device, ask them to enable the existing connector in
   Connections, then test with `connector_run` and check the readings against the real source.
   Only after it works, build screens for its data and controls.
   Connections lists only connectors that exist; validated catalog connectors follow their setup flow.
6. Once it works for the farmer, offer `share_build` for Orbit team review, with their yes.

Rules
- Ask for exports or local APIs before cloud scraping. Prefer read-only access to vendor systems.
- Never write secrets into files. Ask the farmer to enter the password in Connections > Password;
  non-secret settings go through `connector_configure`.
- Keep connectors small and readable; add a short README explaining where the data comes from.
