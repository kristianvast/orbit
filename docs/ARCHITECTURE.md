# Orbit architecture

Orbit is an open-source desktop app that a farmer installs on a PC he owns, for example the
milking-robot management PC. Orion is the AI agent inside Orbit. Core is the cloud side. Orbit
covers cattle (dairy and beef) and horses. The license is AGPL-3.0-only, with a paid commercial
license also available.

## Components

```
 Farm PC (Windows / macOS / Linux)                                   Cloud (Core)
+---------------------------------------------------------------+   +---------------------------+
|  Orbit desktop app (Tauri 2 shell, Rust)                      |   |  @core/api                |
|   |  spawns sidecar, holds token, OS keychain bridge          |   |   - write API (POST ops)  |
|   v                                                           |   |   - LLM gateway (metered  |
|  +---------------------+   WebSocket 127.0.0.1:<port>/ws      |   |     subscription usage)   |
|  | @orbit/app          |<----------------------------------+  |   |  Postgres  (@orbit/schema |
|  | React + TS + Vite   |   @orbit/protocol (JSON frames)    |  |   |            /pg)           |
|  | (webview)           |                                    |  |   |  ElectricSQL (read path)  |
|  +---------------------+                                    |  |   +-------------^-------------+
|                                                             v  |                 |
|  +-----------------------------------------------------------+ |   shapes (rows  | POST outbox
|  | @orion/agent  (Bun sidecar)                               | |   per farm)     | ops (HLC)
|  |  - protocol server (@orbit/protocol)                      | |                 |
|  |  - Pi SDK sessions, tools, approval gate                  |-+-----------------+
|  |  - single writer of local SQLite (@orbit/schema)          |   @orbit/sync
|  |  - @orbit/connectors (Lely, DeLaval, GEA, BouMatic,       |
|  |    Allflex, smaXtec, CowManager, CSV, custom)             |---> LAN devices, robots,
|  |  - farm workspace dir (AGENTS.md, skills, imports)        |     ONVIF/RTSP cameras,
|  +-----------------------------+-----------------------------+     vendor cloud APIs
|                                |                                                   
|                         orbit.db (SQLite, bun:sqlite)                              
+---------------------------------------------------------------+
```

## Package map

| Package             | Path                | Role                                                      |
| ------------------- | ------------------- | --------------------------------------------------------- |
| `@orbit/protocol`   | packages/protocol   | Wire protocol types, typebox validators, codec, client    |
| `@orbit/schema`     | packages/schema     | Drizzle schema (SQLite + Postgres), HLC, migrations, seed |
| `@orion/agent`      | packages/orion      | Orion sidecar: Pi SDK agent + protocol server + DB writer |
| `@orbit/connectors` | packages/connectors | Vendor/device connectors producing rows and observations  |
| `@orbit/sync`       | packages/sync       | Electric shape consumer + outbox pusher                   |
| `@orbit/app`        | apps/orbit          | Tauri 2 shell + React UI                                  |
| `@core/api`         | core/api            | Cloud write API, LLM gateway, Postgres migrations         |
| `@orbit/e2e`        | packages/e2e        | Playwright end-to-end tests against the web build + Orion |

All packages are `"type": "module"` and export TypeScript source (`"exports": {".": "./src/index.ts"}`),
so workspace packages need no build step between them.

## Process model

1. The Tauri shell generates a random token, spawns the Orion sidecar with
   `orion --port 0 --token <token> --data-dir <app data>`, and reads its stdout.
2. Orion binds `127.0.0.1` on an OS-assigned port and prints exactly one line:
   `ORION_READY {"port":N}`. `parseReadyLine()` in `@orbit/protocol` parses it.
3. The shell hands `{ port, token }` to the webview. The UI calls
   `createOrionClient("ws://127.0.0.1:N/ws", token)`.
4. The first frame on each connection must be `hello { token, protocolVersion }`. On a bad token
   the server replies with an `unauthorized` error and closes the socket with code 4401. The
   client does not reconnect after 4401. After any other close it reconnects with backoff and
   sends `hello` again.
5. When the shell quits, it terminates the sidecar.

Browser dev mode: start Orion yourself (`orion --dev --seed`). It listens on
`ws://127.0.0.1:7717/ws` with token `dev` (`DEV_SERVER_URL`, `DEV_TOKEN`). The UI runs under
`vite dev` and needs no Tauri.

## Wire protocol (`@orbit/protocol`)

The transport is one JSON object per WebSocket text frame. There are three frame types:

- Request (client to server): `{ id, type, ...params }`.
- Response: `{ type: "response", id, ok: true, result }` or `{ type: "response", id, ok: false, error: { code, message, details? } }`.
- Event (server to client, no id): `{ type, ...body }`. Every chat event carries `sessionId`.

Requests: `hello`, `sessions.list|create|open|fork|rename|delete`,
`chat.prompt|steer|followUp|abort`, `approval.respond`, `settings.get|update`, `db.query`,
`db.mutate`, `snapshots.list|undo`.

- `sessions.open` returns the transcript as UI-ready `TranscriptItem`s:
  `user | assistant | tool | system`. A tool item already includes its result.
- `chat.prompt` resolves as soon as the server accepts it. Output then streams as events, ending
  with `agent.settled`.
- `db.query` and `db.mutate` accept only named operations (`DbQueries`, `DbMutations`). No raw SQL
  ever crosses the wire.

Events: `session.updated`, `message.start`, `message.delta {text|thinking}`,
`message.end {item}` (authoritative; replaces any accumulated deltas), `tool.start`,
`tool.update {partial}`, `tool.end`, `approval.request`, `approval.resolved`, `agent.settled`,
`db.changed {table, ids}`, `sync.status`, `error`.

Validation uses typebox `Value.Check`, which avoids `eval` and so works under a strict webview CSP.
The server validates every incoming frame with `decodeClientMessage()`. The client validates
events, and by default also validates results.

## Data ownership

- Orion is the **single writer** of the local SQLite database (`orbit.db`). The UI never opens
  the database; it reads with `db.query` and writes with `db.mutate`, both over the protocol.
  Connectors and the sync engine run inside the Orion process.
- Every write made by the agent or the UI records a row in `snapshots` (the before and after state
  of each changed row), so `snapshots.undo` can revert it. After each write commits, Orion emits
  `db.changed`.
- Secrets never go into the database. Camera passwords, connector API keys and LLM keys are kept in
  the OS keychain; tables store only a reference key (`cameras.credential_ref`,
  `connectors.config.credentialRef`).
- **Domain rule:** an animal wears a collar OR a bolus OR an ear tag sensor, never several at once.
  This is enforced in three ways: the partial unique index
  `device_bindings_one_active_wearable_per_animal` (on `wearable = 1 AND unbound_at IS NULL AND
  deleted_at IS NULL`), the `assertSingleWearable()` check that writers call before binding, and
  `findWearableConflict()` for Core. A violation is reported as `rule_violation`.

## Schema (`@orbit/schema`)

The same table and column names are defined twice: in `src/sqlite.ts` (drizzle sqlite-core, for
bun:sqlite) and in `src/pg.ts` (drizzle pg-core).

Synced tables: `farms`, `animals`, `devices`, `device_bindings`, `connectors`, `observations`,
`cameras`. Each one carries these sync columns: `farm_id`, `created_at`, `updated_at`,
`deleted_at` (soft delete), `hlc` and `origin_device`.

Local-only tables: `outbox`, `snapshots`, `sync_state`.

Migrations are generated with `bun run generate`, which runs drizzle-kit and writes
`drizzle/sqlite` and `drizzle/pg`. The SQLite migrations are also embedded into
`src/migrations.gen.ts`, so `migrate(db)` works from a compiled sidecar binary with no migration
files on disk. Applied migrations are tracked in `__orbit_migrations`.

`seedDemoFarm(db)` writes a deterministic demo farm used by `orion --seed`, the UI and e2e tests.

## Sync design (`@orbit/sync`)

- **Read path:** ElectricSQL shapes stream the Postgres rows of each synced table, filtered by
  `farm_id`, into local SQLite. When an incoming row is applied, it replaces the local row only if
  `incoming.hlc > local.hlc` (last-writer-wins per row), and the local HLC then calls
  `receive(incoming.hlc)`. Timestamps from Postgres (`timestamptz`) are normalised to ISO-8601
  strings. Shape handles and offsets are stored in `sync_state`. Local synced tables declare no
  foreign keys because shapes arrive in arbitrary table order.
- **Write path:** a local write and its `outbox` row (`op`, `table`, `row_id`, full-row `payload`,
  `hlc`) are written in the same transaction. The pusher POSTs pending outbox rows in `seq` order
  to the Core write API. Core applies them with the same LWW-by-HLC rule and sets `acked_at`. Failed
  pushes increment `attempts` and record `last_error`.
- **Deletes** are soft (`deleted_at`). Rows are never hard-deleted from synced tables.
- **HLC format:** `<15-digit wall ms>:<6-digit counter>:<node id>`. It sorts lexicographically, and
  the node id breaks ties deterministically (`createHlc`, `tick`, `receive`, `compare`).
- Sync is optional. When Core is not configured, Orbit is fully local and `sync.status` reports
  `disabled`.

## Agent design (`@orion/agent`)

- **One Pi session per conversation.** Sessions are created with `createAgentSession` and stored
  as JSONL under `<data-dir>/sessions`. Session fork, rename and switch are handled with
  `AgentSessionRuntime`. Pi events are translated into protocol events: `message_update` becomes
  `message.delta`, tool execution start/update/end become `tool.*`, `message_end` becomes
  `message.end`, and `agent_settled` becomes `agent.settled`.
- **Farm workspace:** the agent's `cwd` is `<data-dir>/workspace`. It holds `AGENTS.md` (farm
  context: herd, devices, routines), skills (for example connector setup and camera discovery),
  imports and scripts. These are loaded through `DefaultResourceLoader`.
- **Tools:** farm tools are registered as Pi custom tools (typebox parameters). They call the same
  named query and mutation layer as `db.query` and `db.mutate`. Coding tools (read/edit/bash)
  operate inside the workspace.
- **Approval gate:** Pi has no permission system of its own, so Orion adds one with a `tool_call`
  extension hook that classifies every call into a tier:
  - `safe`: reads and pure queries. Runs without asking.
  - `ask`: writes and shell commands inside the workspace. The gate emits `approval.request`,
    waits for `approval.respond`, and blocks the call on `deny`. `always_allow` remembers the
    tool in `settings.alwaysAllow`.
  - `always_ask`: network access to devices, deleting data, and anything outside the workspace.
    These always prompt, even under remembered allows or `approvalMode: "auto"`.
  - `approvalMode`: `ask` is the default. `auto` auto-allows the `ask` tier. `read_only` denies
    every non-safe call without prompting.
    Every approval card shows a plain-language description, plus the exact command when there is one,
    and the UI tells the farmer that AI can make mistakes. Extension UI prompts (`ctx.ui.confirm`,
    `select`, `input`) are rendered through the same approval-card mechanism.
- **Models:** the farmer picks a provider and model with `settings.update`. Usage runs either on
  the farmer's own API key (stored in the keychain) or on the Core LLM gateway, which meters
  subscription usage.

## Compute rule

The developer Mac runs only light checks: install, Biome, tsc, bun test, vitest, Vite and
Playwright. Rust, Tauri bundles and `bun build --compile` sidecars are built in GitHub Actions
only.
