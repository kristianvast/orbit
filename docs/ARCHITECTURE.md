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
|  |  - Pi SDK sessions, tools, undo snapshots                 |-+-----------------+
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
`chat.prompt|steer|followUp|abort`, `pages.list`, `localUi.status|launched|booted|disable`, `settings.get|update`, `db.query`,
`db.mutate`, `snapshots.list|undo`.

- `sessions.open` returns the transcript as UI-ready `TranscriptItem`s:
  `user | assistant | tool | system`. A tool item already includes its result.
- `chat.prompt` resolves as soon as the server accepts it. Output then streams as events, ending
  with `agent.settled`.
- `db.query` and `db.mutate` accept only named operations (`DbQueries`, `DbMutations`). No raw SQL
  ever crosses the wire.

Events: `session.updated`, `message.start`, `message.delta {text|thinking}`,
`message.end {item}` (authoritative; replaces any accumulated deltas), `tool.start`,
`tool.update {partial}`, `tool.end`, `agent.settled`,
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
`cameras`, `camera_layouts`. Each one carries these sync columns: `farm_id`, `created_at`, `updated_at`,
`deleted_at` (soft delete), `hlc` and `origin_device`.

Local-only tables: `outbox`, `snapshots`, `sync_state`.

Migrations are generated with `bun run generate`, which runs drizzle-kit and writes
`drizzle/sqlite` and `drizzle/pg`. The SQLite migrations are also embedded into
`src/migrations.gen.ts`, so `migrate(db)` works from a compiled sidecar binary with no migration
files on disk. Applied migrations are tracked in `__orbit_migrations`.

`seedDemoFarm(db)` writes a deterministic demo farm used by `orion --seed`, the UI and e2e tests.

### ICAR ADE

The data model follows [ICAR ADE v1.5.1](https://github.com/adewg/ICAR), the livestock data
exchange standard. `animals` stores the ADE identity and state fields: `national_id` plus
`identifier_scheme` (the ADE identifier), `alternative_identifiers` (`[{ id, scheme }]`),
`reproduction_status` and `lactation_status`. `observations.kind` covers the ADE animal events
(insemination, pregnancy check, calving, abortion, dry-off, treatment, arrival, departure, birth,
death, plus milking, weight, heat and diagnosis). For those kinds `value_json` stores the ADE event
properties under their ADE names.

`@orbit/schema/ade` converts in both directions: `animalToAde` and `observationToAde` export rows,
and `adeToAnimal` and `adeToObservation` import ADE JSON into columns, throwing `AdeMappingError`
before anything is returned. Animals without an official identifier are exported under the
`orbit.animal` scheme with their Orbit UUID, and farms map to the ADE location (`orbit.farm`). The
official schemas are vendored in `vendor/icar-ade-1.5.1`, and `test/ade.test.ts` validates every
mapped resource against them.

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
- Sync is optional. When Core is not configured, or nobody is signed in, Orbit is fully local and
  `sync.status` reports `disabled`. Writes made while signed out stay in the outbox and are pushed
  after sign-in.

## Accounts, farm roles and invites (Core)

- **Billing:** `core/api/src/plans.ts` defines EUR Free, Pen and Barn plans and hardware.
  Session members read `/v1/billing/status`; owners and managers create Stripe checkout and
  portal sessions. Stripe-signed `/v1/billing/webhook` events update farm subscriptions in the
  same transaction as their idempotency claim. Stripe customer IDs stay farm-scoped.
  `/v1/billing/plans` and hardware checkout are public. `CORE_CORS_ORIGINS` allows the website
  to use account, farm and billing routes.
- **Accounts** live in Core (`core/api/src/accounts.ts`): `POST /v1/auth/register|login|logout`,
  `GET /v1/me`. Passwords are argon2id hashes (`Bun.password`); session tokens (`orb_s_...`, 90
  days) and invite codes (`orb_i_...`) are stored only as SHA-256 hashes. Ten failed sign-ins per
  email in 15 minutes answer 429; unknown emails and wrong passwords get the same 401.
- **Farms and roles:** `farm_members` gives each user one role per farm: `owner`, `manager`,
  `worker` or `viewer`. The matrix is shared in `@orbit/schema/roles` (`canWriteTable`,
  `assignableRoles`, `canManageMember`) so Core and Orion enforce the same rule. Workers change
  animals, devices, device bindings and observations; farm settings, connectors and cameras are for
  owners and managers; viewers only read. Only owners make owners, and a farm always keeps one owner.
  `POST /v1/farms` creates a farm, or with `id` claims a local farm the cloud has never seen.
- **Invites:** owners and managers invite by email and role (`/v1/farms/:id/invites`). The code is
  shown once, works once, only for that email address, and expires after 7 days
  (`POST /v1/invites/accept`). Sending the code is up to the inviter; Core sends no email yet.
- **Farm-scoped routes** (`/v1/changes`, `/v1/shape`, `/v1/llm/*`) take a user session plus the
  `x-orbit-farm` header (membership required; `/v1/changes` rejects rows the role may not change),
  or a legacy per-farm api token, which keeps owner rights.
- **Orion** (`--core-url` / `ORBIT_CORE_URL`) relays `account.*`, `members.*` and `invites.*` for the
  UI, keeps the session in the secret store (OS keychain), links the local farm (member: use the
  role; unknown to the cloud: claim it as owner; someone else's: stay local with `linkError` until an
  invite is accepted), runs `@orbit/sync` with the session, and applies the same role matrix to
  `db.mutate` and the agent's farm tools (`forbidden`).

## Agent design (`@orion/agent`)

- **One Pi session per conversation.** Sessions are created with `createAgentSession` and stored
  as JSONL under `<data-dir>/sessions`. Session fork, rename and switch are handled with
  `AgentSessionRuntime`. Pi events are translated into protocol events: `message_update` becomes
  `message.delta`, tool execution start/update/end become `tool.*`, `message_end` becomes
  `message.end`, and `agent_settled` becomes `agent.settled`.
- **Farm workspace:** the agent's `cwd` is `<data-dir>/workspace`. It holds `AGENTS.md` (farm
  context: herd, devices, routines), skills (for example connector setup and camera discovery),
  imports and scripts. These are loaded through `DefaultResourceLoader`.
- **Memory:** `memory/farm.md` (facts about the farm) and `memory/user.md` (facts about the
  person using Orbit) live in the workspace and are loaded as context files for every new session.
  Orion edits them with `memory_remember` and `memory_forget` without asking. Workspace snapshots
  keep them undoable.
- **Tools:** farm tools are registered as Pi custom tools (typebox parameters). They call the same
  named query and mutation layer as `db.query` and `db.mutate`. Pi's coding tools (read/write/edit/bash)
  start in the workspace and can reach the rest of the machine.
- **Computer use:** the `computer` tool (`agent/computer.ts`) takes screenshots of the main screen
  and sends mouse and keyboard input, so Orion can work in programs that have no connector. It uses
  the operating system's own tools and adds no native dependency: macOS `screencapture`/`sips`/
  `osascript` (needs Screen Recording and Accessibility for Orbit), Windows PowerShell with user32
  and `SendKeys`, Linux X11 `xdotool` plus ImageMagick `import` (Wayland is refused). Each call is
  one atomic action, so nothing is held between calls and `chat.abort` stops it. Missing
  permissions or tools come back as `Refused (<code>)` results that tell Orion to stop and ask the
  farmer instead of retrying.
- **No approval gate:** Orion trusts the model, like the Pi agent itself. Tool calls run
  directly; the system prompt and `resources/AGENTS.md` tell Orion to explain risky or hard-to-undo
  steps and wait for the farmer's yes in the chat. Undo snapshots are the safety net.
- **Custom pages (runtime UI):** Orion adds screens by writing `pages/<id>/index.html` (plus an
  optional `page.json` with `title`/`description`) in the workspace. `pages.list` returns them and the
  app shows them under "Your pages" in a sandboxed iframe (`allow-scripts allow-forms`). Orion serves
  the files at `/pages/<token>/<id>/...` on its localhost port, so only token holders can load them,
  and `/pages/<token>/_orbit.js` gives pages `orbit.query`, `orbit.mutate`, `orbit.request` and
  `orbit.on` over the normal protocol. The `custom-pages` skill describes the contract.
- **Source editing (dev):** with `--app-source <checkout>` (or `ORBIT_APP_SOURCE`) Orion's system
  prompt names the Orbit checkout and loads its `AGENTS.md`, so Orion can change the app and itself
  (`apps/orbit/src` hot-reloads, `packages/orion` restarts under `bun --watch`). The Orion dev script
  passes `--app-source ../..`. Installed builds have no checkout and use custom pages instead.
- **Your Orbit (local UI build):** to change existing screens, Orion edits an Orbit checkout
  (`--app-source`, else `<data-dir>/app`, cloned at the installed version's tag by the `editing-orbit`
  skill) and runs `local_ui_build`: install (first time), `bun run typecheck`, `bun run build:local`
  (`vite build --base ./`). Only a passing build turns on `<data-dir>/local-ui.json` and emits
  `localUi.updated` (a running local UI reloads). Orion serves `<checkout>/apps/orbit/dist` at
  `/app/<token>/` with an injected `<base href>` and SPA fallback. At startup the shipped UI (Tauri, or
  web with `VITE_LOCAL_UI_HANDOFF=1`) asks `localUi.status`; on `ready` it calls `localUi.launched` and
  navigates there with `#return=<shipped url>`. The local build derives its endpoint from its own
  origin and path token, calls `localUi.booted` once connected, and Settings > Your Orbit can send the
  farmer back (`localUi.disable`). A launch that never boots reads as `broken`, so the next start stays
  on the shipped UI; `?safe` skips the hand-off. Schema, protocol, sync and Orion are never rebuilt.
- **Models:** the farmer picks a provider and model with `settings.update`. Usage runs either on
  the farmer's own API key (stored in the keychain) or on the Core LLM gateway, which meters
  subscription usage. Signing in to an Orbit account makes the cloud model the default when no
  model was chosen: provider `orbit-gateway`, model `orbit-default`, sent to
  `<core>/v1/llm/v1` with the session and `x-orbit-farm`; Core maps `orbit-default` to
  `LLM_DEFAULT_MODEL` and calls the provider with its own key. Signing out clears that default.
  Active or trialing Pen includes 3 million tokens and 60 voice minutes per UTC month; Barn
  includes 15 million and 300 minutes. Free cloud calls return 402 `plan_required`, while BYO
  providers remain available. `farm_budgets` overrides the token allowance; legacy farm API
  tokens retain their previous default/override budget behavior.
  `LLM_UPSTREAM_AUTH=google` uses cached ADC OAuth tokens and the global Vertex OpenAI endpoint,
  mapping `orbit-default` to `google/gemini-3.8-flash` and stripping Orion's `/v1` prefix.
  `/v1/voice/live` requires a session and farm membership, proxies Gemini Live JSON frames to
  Vertex in `us-central1`, forces `VOICE_MODEL=gemini-3.8-live`, meters connected seconds in
  `voice_usage`, and closes with 4402 when the allowance is consumed. No paid plan returns
  HTTP 402 before WebSocket upgrade.

## Camera relay

`camera_layouts` stores the version 2 barn-map layout as JSON, with one live row per farm.
`cameraLayout.get` and `cameraLayout.save` use Orion's normal snapshot, HLC and outbox write path.
The layout row uses the farm UUID so independent devices converge through row-level LWW.

Orion owns an optional go2rtc v1.9.15 child process. It resolves `ORION_GO2RTC_BIN`, a binary
beside Orion, `<data-dir>/bin/go2rtc`, then `go2rtc` on PATH. Packaged desktop builds include it.
The API binds to a free loopback port; RTSP, WebRTC and SRTP listeners are disabled. Orion
proxies snapshots and MSE text/binary WebSockets at `/camera/<token>/<cameraId>/frame.jpeg`
and `/camera/<token>/<cameraId>/ws`, using the same token authentication as local UI routes.
`cameras.relay` reports availability; missing binaries and child exits leave Orion running
and camera routes return 503.

The child receives only inline configuration, without streams. Camera URLs and credentials
from the secret store are registered through the runtime stream API at startup and after
camera changes; removed streams are deleted. No plaintext credentials are written to a go2rtc
config file or process arguments. The pinned go2rtc API applies runtime changes before
returning `400 config file disabled` when persistence is disabled; Orion accepts only that
specific persistence error. Child output is captured in bounded memory and the child is
terminated when Orion stops.

## Voice agent

Orion owns each `voice.start` session and connects to Core's `/v1/voice/live` WebSocket
with the stored account session and `x-orbit-farm`, after checking paid-plan voice allowance.
A Gemini API key in Orion's provider credential store enables direct Gemini Live access
without a cloud plan; keys never cross the app protocol. `--mock-model` uses a deterministic
Gemini-protocol transport that still executes the real farm queries and mutations.

The app sends base64 PCM16 mono at 16 kHz via `voice.audio`, captured with an AudioWorklet,
and plays the streamed 24 kHz PCM replies. Orion speaks Gemini's BidiGenerateContent JSON
protocol, forwards live transcripts and tool events, and answers function calls with
`toolResponse`. `db_query` and `db_mutate` use the same named farm operations as the app;
mutations enforce the user's farm role, the one-wearable rule, and undo snapshots.
Disconnecting, signing out, stopping voice or shutting down Orion closes the upstream
session. Billing requests are relayed to Core; Core owns subscription state and metering.

## Compute rule

The developer Mac runs only light checks: install, Biome, tsc, bun test, vitest, Vite and
Playwright. Rust, Tauri bundles and `bun build --compile` sidecars are built in GitHub Actions
only.
