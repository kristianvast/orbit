# AGENTS.md: Coding Agent Guide for Orbit

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing shared contracts or cross-package wiring.

## Package map

All workspaces use `"type": "module"`, `"license": "AGPL-3.0-only"`, and source-first exports (`"exports": { ".": "./src/index.ts" }`), so no build step is needed between workspace packages.

| Package             | Path                                         | Responsibility                                                                                                                                                      |
| ------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@orbit/protocol`   | [`packages/protocol`](packages/protocol)     | WebSocket JSON frames, TypeBox schemas (`feedback.ts`, `account.ts`, `billing.ts`), `Value.Check` codec, `OrionClient`                                              |
| `@orbit/schema`     | [`packages/schema`](packages/schema)         | Drizzle SQLite + PG tables, HLC (`src/hlc.ts`), wearable rule (`src/wearable.ts`), ICAR ADE (`src/ade.ts`), migrations, seed                                        |
| `@orion/agent`      | [`packages/orion`](packages/orion)           | Bun sidecar: protocol server, Pi SDK sessions, tools, feedback/sharing, undo snapshots (`isomorphic-git`), SQLite writer                                            |
| `@orbit/connectors` | [`packages/connectors`](packages/connectors) | Connector SDK (`defineConnector`), CSV/XML/tabular parsers, starter template, and built-in generic CSV adapter                                                      |
| `@orbit/sync`       | [`packages/sync`](packages/sync)             | Outbox pusher (`POST /v1/changes`) + ElectricSQL shape consumer (`GET /v1/shape`) with LWW-by-HLC                                                                   |
| `@orbit/app`        | [`apps/orbit`](apps/orbit)                   | Tauri 2 shell (`src-tauri`) + React/TS/Vite UI + design system ([DESIGN.md](apps/orbit/DESIGN.md))                                                                  |
| `@core/api`         | [`core/api`](core/api)                       | Hono cloud API (`/v1/changes`, `/v1/shape`, `/v1/llm/*`, `/v1/voice/*`, `/v1/auth/*`, `/v1/billing/*`, `/v1/feedback`, `/v1/submissions`, `/admin`) + PG migrations |
| `@orbit/e2e`        | `packages/e2e`                               | Playwright e2e suite against the Vite web build and live Orion sidecar                                                                                              |

## Commands

- **Install dependencies (SERIALIZED):** Always run [`scripts/locked-install.sh`](scripts/locked-install.sh), never `bun install` or `bun add` directly.
  - Plain link/install: `scripts/locked-install.sh`
  - Add dep to a package: `scripts/locked-install.sh packages/orion <pkg>`
  - Internal deps: add `"@orbit/schema": "workspace:*"` to `package.json`, then run `scripts/locked-install.sh`.
- **Lint / Format:** `bun run lint` (`biome check .`) or `bun run lint:fix`
- **Typecheck all:** `bun run typecheck` (or per package: `bun run --filter '@orbit/schema' typecheck`)
- **Test all:** `bun run test` (or per package: `bun run --filter '@orion/agent' test`)
- **Dev servers:** `bun run --filter '@orion/agent' dev` (`127.0.0.1:7717`, token `dev`) and `bun run --filter '@orbit/app' dev`
- **Schema migrations:** `cd packages/schema && bun run generate` (runs `drizzle-kit` for SQLite + PG and embeds SQLite SQL into `src/migrations.gen.ts`).
- **Skills catalog index:** `bun run skills:index` (regenerates `skills/index.json`; `bun run skills:index --check` verifies it).

## Contracts & data flow

- **Single local writer:** `@orion/agent` owns `orbit.sqlite`. `@orbit/app` never opens SQLite directly; it calls named `db.query` and `db.mutate` operations over `@orbit/protocol`. No raw SQL crosses the WebSocket.
- **Synced vs local tables (`@orbit/schema`):**
  - Synced (SQLite + PG parity): `farms`, `animals`, `devices`, `device_bindings`, `connectors`, `observations`, `cameras`, `camera_layouts`. Every synced row carries `farm_id`, `created_at`, `updated_at`, `deleted_at` (soft delete only), `hlc`, and `origin_device`.
  - Local-only (SQLite): `outbox`, `snapshots` (undo log for DB + `isomorphic-git` workspace commits), `sync_state`.
- **Feedback & shared builds:** Orion relays `feedback.send` (`POST /v1/feedback`, works signed out) and `shared.list` / `share_build` / `share_status` (`POST` & `GET /v1/submissions`, requires sign-in, refuses files matching secret patterns; reviewed via `/v1/admin/*` and `/admin` using `CORE_ADMIN_TOKEN`).
- **Voice:** The app runs the ElevenLabs client SDK against Orion's own socket (`/voice/<token>/<voiceId>` from `voice.start`); Orion relays it to Core's `/v1/voice/agent` and no key reaches the app. Finished turns and tool calls go through `voice.turn` / `voice.tool` and are saved in the conversation like chat. The agent's prompt and its five client tools live in `core/api/src/orion-voice-agent.ts` and must stay in step with `packages/protocol/src/voice.ts` and the `app` tool in `apps/orbit/src/features/guide`.
- **Protocol handshake:** First frame on `ws://127.0.0.1:<port>/ws` must be `hello { token, protocolVersion: 1 }`. Bad token closes with `4401` (terminal, do not reconnect).

## Hard invariants

1. **One-wearable domain rule:** An animal wears a collar OR a bolus OR an ear tag sensor (`WEARABLE_KINDS`), never several at once. At most ONE active wearable binding per animal (`wearable = 1 AND unbound_at IS NULL AND deleted_at IS NULL`). Enforced by `device_bindings_one_active_wearable_per_animal`, `assertSingleWearable()`, and `findWearableConflict()`. Never write copy or code that stacks multiple wearables on the same animal.
2. **Species & neutral copy:** Orbit supports cattle (dairy and beef) and horses. Keep all product copy globally neutral (no country-specific defaults or assumptions).
3. **Never commit secrets:** Never commit API keys, `.env` files, or credentials. At runtime, LLM keys, connector secrets, and camera passwords go to the OS keychain (or `pi/auth.json` / encrypted store); SQLite and Postgres store only reference IDs (`credential_ref` / `credentialRef`).
