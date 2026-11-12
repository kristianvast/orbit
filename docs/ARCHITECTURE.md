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
|  |  - @orbit/connectors (generic CSV + custom connectors)    |
|  |  - farm workspace dir (AGENTS.md, pages, skills,          |---> LAN devices, robots,
|  |    connectors, memory)                                    |     ONVIF/RTSP cameras,
|  +-----------------------------+-----------------------------+     vendor cloud APIs
|                                |                                                   
|                       orbit.sqlite (SQLite, bun:sqlite)                            
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
5. When the shell quits, it terminates the sidecar. Orion runs with `--parent-watch` and exits when
   its stdin pipe closes, so a force-killed shell never leaves an orphaned Orion holding the database.
6. If Orion exits on its own, the shell restarts it with backoff (up to 5 tries). A restarted Orion has
   a new port and token; while its client is reconnecting, the UI re-reads `orion_endpoint` and switches.
   After the last try, `orion_endpoint` answers `stopped: <reason + last stderr lines>`, the UI shows
   "Orion has stopped" with that reason, and its Restart button calls `orion_restart`.

Browser dev mode: start Orion yourself (`orion --dev --seed`). It listens on
`ws://127.0.0.1:7717/ws` with token `dev` (`DEV_SERVER_URL`, `DEV_TOKEN`). The UI runs under
`vite dev` and needs no Tauri.

## Wire protocol (`@orbit/protocol`)

The transport is one JSON object per WebSocket text frame. There are three frame types:

- Request (client to server): `{ id, type, ...params }`.
- Response: `{ type: "response", id, ok: true, result }` or `{ type: "response", id, ok: false, error: { code, message, details? } }`.
- Event (server to client, no id): `{ type, ...body }`. Every chat event carries `sessionId`.

Requests: `hello`, `sessions.list|create|open|fork|rename|delete`,
`chat.prompt|steer|followUp|abort`, `modules.list|enable|disable`, `pages.list`, `localUi.status|launched|booted|disable`, `settings.get|update`, `auth.providers|login|respond|cancel|logout`, `account.*`, `members.*`, `invites.*`, `billing.plans|status|checkout|portal`, `feedback.send`, `shared.list`, `voice.start|stop|turn|tool`, `db.query`,
`db.mutate`, `snapshots.list|undo`.

- `sessions.open` returns the transcript as UI-ready `TranscriptItem`s:
  `user | assistant | tool | system`. A tool item already includes its result.
- `chat.prompt` resolves as soon as the server accepts it. Output then streams as events, ending
  with `agent.settled`.
- `db.query` and `db.mutate` accept only named operations (`DbQueries`, `DbMutations`). No raw SQL
  ever crosses the wire.

Events: `session.updated`, `message.start`, `message.delta {text|thinking}`,
`message.end {item}` (authoritative; replaces any accumulated deltas), `tool.start`,
`tool.update {partial}`, `tool.end`, `agent.settled`, `modules.updated`,
`db.changed {table, ids}`, `sync.status`, `error`.

Validation uses typebox `Value.Check`, which avoids `eval` and so works under a strict webview CSP.
The server validates every incoming frame with `decodeClientMessage()`. The client validates
events, and by default also validates results.

## Data ownership

- Orion is the **single writer** of the local SQLite database (`orbit.sqlite`). The UI never opens
  the database; it reads with `db.query` and writes with `db.mutate`, both over the protocol.
  Connectors and the sync engine run inside the Orion process.
- Every write made by the agent or the UI records a row in `snapshots` (the before and after state
  of each changed row), and every agent run that modifies files in `<data-dir>/workspace` commits a
  workspace snapshot using `isomorphic-git` (bundled pure-JS Git, so Git does not need to be
  installed on the farm PC) and records it in `snapshots` (`table: "workspace"`). `snapshots.undo`
  can revert either kind of snapshot. After each database write commits, Orion emits `db.changed`.
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

- **Billing:** `core/api/src/plans.ts` defines the `free`, `orion`, `cam2`, `cam4` and `cam6` plans and hardware.
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
  UI, keeps the session encrypted in the data dir (`account-session.enc.json`, so it lasts as long as the farm's data; Windows drops keychain entries when an admin resets the user's password), links the local farm (member: use the
  role; unknown to the cloud: claim it as owner; someone else's: stay local with `linkError` until an
  invite is accepted), runs `@orbit/sync` with the session, and applies the same role matrix to
  `db.mutate` and the agent's farm tools (`forbidden`).
- **First-run setup (`useNeedsSetup`):** when `account.status` is `"signed_out"` and
  `settings.get` reports no `availableModels`, Home renders the first-run setup card (`home-setup`)
  offering to create a free Orbit account (30-day free trial of Orion, no card needed), sign in, or
  configure a bring-your-own AI provider key in Settings.

## Feedback and sharing

- **Feedback (`feedback.send` / `feedback_send`):** farmers can send feedback (`issue`, `idea`, or
  `other`) from Settings > Feedback or by asking Orion (which shows the exact text and waits for a
  yes before calling `feedback_send`). Orion attaches `appVersion` and `os` and posts to Core's
  `POST /v1/feedback` (`session: "optional"`, so signed-out installs can send feedback too, with an
  optional `contactEmail`). Core rate-limits `POST /v1/feedback` to 20 messages per 24 hours per
  user or hashed client IP (`feedback_rate_events`) and stores rows in `feedback`.
- **Sharing farm builds (`share_build` / `share_status` / `shared.list`):** when a farm builds a
  custom page (`pages/<name>`), connector (`connectors/<name>`), or skill (`skills/<name>`), Orion
  can submit it for review with `share_build` after the farmer says yes. `collectBuild()` walks the
  folder, skips hidden/generated directories and binary files, enforces limits (at most 60 text
  files and 512 KB total), and scans every line against `SECRET_PATTERNS`, refusing with
  `rule_violation` if any line looks like a password, secret, or API key. Passing builds are posted
  to `POST /v1/submissions` (requires a signed-in user session) and stored in `submissions` with
  status `pending`. Farmers and Orion check review status (`pending`, `approved`, `rejected`, plus
  any `reviewNote`) via `GET /v1/submissions` (`shared.list` in the UI and `share_status` for
  Orion). Approved builds reach other farms only after the Orbit team reviews them and adds them to
  the `skills/` catalog in git.
  Other workspace software is packaged and tested as a self-contained `skills/<name>/` folder
  with `SKILL.md`, source and run instructions; arbitrary folders and binaries cannot be shared.
- **Admin review:** Core serves admin endpoints under `/v1/admin/feedback` and
  `/v1/admin/submissions` (list, inspect files, and `PATCH` status/review notes) plus a browser
  review page at `/admin`, all gated by `CORE_ADMIN_TOKEN` (returned as 404 when unset).

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
  start in the workspace and can reach the rest of the machine. On Windows Orion also switches on
  Pi's `powershell` tool, and drops `bash` when no bundled MinGit shell sits next to the sidecar, so
  a shell always exists. Because a custom system prompt replaces Pi's own tool rules, the prompt in
  `agent/hub.ts` carries Orion's working rules plus a "This computer" block (`computerPrompt`:
  system, shell, Orbit version, workspace, data folder, checkout) so Orion never has to probe for them.
- **Conversation titles:** a new conversation is listed under its opening line. The moment its first
  message is sent, beside the run, `SessionHub.nameSession` asks a small model for a short title
  (`agent/title.ts`) and emits `session.updated`: on the subscription that is the gateway's
  `orbit-small` (Core maps it to `LLM_SMALL_MODEL`), with the farmer's own key the cheapest paid text
  model of the same provider, and the conversation's own model only if the small one is refused. A
  title the farmer set is never replaced.
- **Web access:** `web_search` and `web_fetch` (`agent/web.ts`) run on the farm PC with no
  account or key: search goes to DuckDuckGo's HTML endpoint and pages are turned into text with
  `HTMLRewriter`. The `browser` tool (`agent/browser.ts`) drives a headless browser through
  `Bun.WebView` (system WebKit on macOS, an installed Edge or Chrome elsewhere) with a persistent
  profile in `<data-dir>/browser-profile`; every action returns the page as text plus numbered
  items to act on. All three label their output as untrusted, and the system prompt tells Orion
  never to follow instructions found on the web.
- **Computer use:** the `computer` tool (`agent/computer.ts`) takes screenshots of the main screen
  and sends mouse and keyboard input, so Orion can work in programs that have no connector. It uses
  the operating system's own tools and adds no native dependency: macOS `screencapture`/`sips`/
  `osascript` (needs Screen Recording and Accessibility for Orbit), Windows PowerShell with user32
  and `SendKeys`, Linux X11 `xdotool` plus ImageMagick `import` (Wayland is refused). Each call is
  one atomic action, so nothing is held between calls and `chat.abort` stops it. `type` and `key`
  are refused while the focused window belongs to Orbit itself (Orion's parent process), because
  those keys would land in the chat box and be sent as the farmer's messages. Missing
  permissions or tools come back as `Refused (<code>)` results that tell Orion to stop and ask the
  farmer instead of retrying.
- **No approval gate:** Orion trusts the model, like the Pi agent itself. Tool calls run
  directly; the system prompt and `resources/AGENTS.md` tell Orion to explain risky or hard-to-undo
  steps and wait for the farmer's yes in the chat. Undo snapshots are the safety net.
### Minimal-first modules

Orbit starts minimal. **Home**, **Chat** (Ask Orion), **Settings**, and **Your pages** (custom pages) are always present and are not modules. Built-in domain screens are optional modules that start disabled on a fresh install:

The `devices` module is called **Connections** and lists only existing connectors. Orbit ships no
ready sensor connection: Orion builds unvalidated connections with the farmer and tests them
against the real device before showing their data or controls; validated catalog skills supply their own setup.

- **Protocol contract (`@orbit/protocol`):** `MODULE_IDS = ["herd", "devices", "cameras"] as const` (`ModuleId` is the union of those three literals). Each `OrbitModule` has `{ id: ModuleId, enabled: boolean, enabledAt: string | null, enabledBy: "orion" | "user" | "auto" | null }` (`enabledAt` is an ISO timestamp). `ModulesState` is `{ modules: OrbitModule[] }`, always containing all three IDs in `MODULE_IDS` order.
- **Wire messages:** `modules.list` (empty params) returns `ModulesState`; `modules.enable` and `modules.disable` take `{ id: ModuleId }` and return `ModulesState`. Orion emits `modules.updated` with body `ModulesState` on every change from any cause.
- **Agent tool:** `orbit_modules` with `{ action: "list" | "enable" | "disable", id?: ModuleId }`.
- **Persistence and auto-enable:** Orion persists state in `<data-dir>/modules.json`. A module is enabled by Orion (`enabledBy: "orion"`), by the farmer in Settings (`"user"`), or automatically (`"auto"`) when live data for that area first appears (any non-deleted row in `animals` enables `herd`, `devices` enables `devices`, and `cameras` enables `cameras`). Existing farms that already have data auto-enable their matching modules on first load.

- **Custom pages (runtime UI):** Orion adds screens by writing `pages/<id>/index.html` (plus an
  optional `page.json` with `title`/`description`) in the workspace. `pages.list` returns them and the
  app shows them under "Your pages" in a sandboxed iframe (`allow-scripts allow-forms`). Orion serves
  the files at `/pages/<token>/<id>/...` on its localhost port, so only token holders can load them,
  and `/pages/<token>/_orbit.js` gives pages `orbit.query`, `orbit.mutate`, `orbit.request` and
  `orbit.on` over the normal protocol. The `custom-pages` skill describes the contract.
- **Page cards and the page kit:** a `page.json` with `"card": "card.html"` (a file directly in the
  page folder) makes `pages.list` return `card.path`, and Home shows that file as a card: a
  non-interactive sandboxed frame inside a tile that links to `/pages/<id>`. The app passes its
  theme and language to every page and card frame as `?theme=&lang=`, and `_orbit.js` applies them.
  `/pages/<token>/_orbit.css` is the app's own `design/tokens.css` followed by
  `packages/orion/resources/pages/kit.css`, and `/fonts/<name>` serves the app's fonts, so pages
  look like the app without copying it. A sandboxed frame has an opaque origin, so everything under
  `/pages/<token>/` and `/fonts/` is sent with `Access-Control-Allow-Origin: *`; the token in the
  path remains the access check. That is what lets a page use module scripts and
  `fetch("./config.json")`.
- **Ready-made views (`skills/farm-views`):** a catalog skill whose `skill.json` lists `pages`
  (`[{ id, dir }]`). The `page_scaffold { fromSkill, page, id? }` tool copies one into
  `pages/<id>/` and never replaces an existing page. Each view keeps what the farmer sees in its
  `config.json` and its rules in one tested module (`herd.js`, `calendar.js`, `cameras.js`;
  `repro.js` is shared by copy and pinned identical by `skills/farm-views/views.test.ts`).
  `orion --seed` installs all of them into the demo farm when the catalog is a local folder.
- **Source editing (dev):** with `--app-source <checkout>` (or `ORBIT_APP_SOURCE`) Orion's system
  prompt names the Orbit checkout and loads its `AGENTS.md`, so Orion can change the app and itself
  (`apps/orbit/src` hot-reloads, `packages/orion` restarts under `bun --watch`). The Orion dev script
  passes `--app-source ../..`. Installed builds have no checkout and use custom pages instead.
- **Your Orbit (local build):** to change Orbit itself, Orion runs `orbit_source` (clones the
  installed version's tag into `<data-dir>/app` on a `farm` branch and installs dependencies; a
  no-op once it is there; `--app-source` replaces it in dev), edits, and runs `local_ui_build`:
  commit the edits (`summary`), `bun run typecheck`, `bun run build:local` (`vite build --base ./`).
- **Orion's own build (`services/local-orion.ts`):** when the checkout's Orion packages differ from
  the release tag, the same build also typechecks `packages/orion` and starts it once on a throwaway
  data folder; only then is `<data-dir>/local-orion.json` switched on. Orion is not recompiled: the
  shipped binary is also a Bun runtime, so at startup `main.ts` runs the checkout's
  `packages/orion/src/main.ts` in its own place (`LocalOrion.supervise`), passing stdio straight
  through. A build that never reports ready, or exits non-zero, switches the marker off, and the
  shipped Orion runs instead (its prompt then tells Orion why). After such a build Orion restarts
  itself once no conversation is running: it shuts down cleanly and the desktop shell, which
  restarts Orion whenever it exits, starts the new one. Continuing with the app's part: Only a passing build turns on `<data-dir>/local-ui.json` and emits
  `localUi.updated` (a running local UI reloads; the shipped UI shows an "Open new version" bar, and
  the tool result's `reloads` flag tells Orion which of the two to tell the farmer). Orion serves `<checkout>/apps/orbit/dist` at
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
  Plans are `free`, `orion`, `cam2`, `cam4` and `cam6`; Core supplies their names, prices
  and allowances through `billing.plans`. A free Orion month keeps the `free` plan with
  `trialEndsAt` and cloud allowances. Calls without an allowance return 402 `plan_required`, while BYO
  providers remain available. `farm_budgets` overrides the token allowance; legacy farm API
  tokens retain their previous default/override budget behavior.
  `LLM_UPSTREAM_AUTH=google` uses cached ADC OAuth tokens and the global Vertex OpenAI endpoint,
  mapping `orbit-default` to `google/gemini-3.8-flash` and stripping Orion's `/v1` prefix.
  Core's `/v1/voice/live` and `/v1/voice/agent` require a session and farm membership and share
  voice entitlement checks, connected-second metering in `voice_usage`, and close code 4402
  when the allowance is consumed. Without a paid plan or free month they return HTTP 402
  before WebSocket upgrade. The existing live route proxies Gemini Live JSON frames to Vertex
  in `us-central1` and forces `VOICE_MODEL=gemini-3.8-live`. The agent route relays opaque
  ElevenLabs text frames for `VOICE_AGENT_ID`, using `ELEVENLABS_API_KEY` to obtain a signed
  upstream URL that stays server-side. Missing configuration returns 503; signed-URL failures
  return 502 before upgrade without recording usage.

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

The app runs the official ElevenLabs client SDK in WebSocket mode. `voice.start` checks
the conversation and the account's plan and voice allowance, then returns a local
`/voice/<token>/<voiceId>` path and the `farm_name` and `conversation_recap` dynamic variables.
Orion relays JSON text frames verbatim to Core's `/v1/voice/agent`, using the stored account
session and `x-orbit-farm`; Core connects to ElevenLabs and meters usage. No key reaches the app.
Frames sent before Core connects are delivered in order. A budget close (4402) also emits
`error` with `budget_exceeded`. Each call accepts one SDK socket and belongs to one protocol socket.

The SDK reports finished user and assistant turns through `voice.turn`. Orion appends real Pi
messages with a persistent `voice: true` marker, so the text agent reads spoken conversation.
During a chat run those writes wait until settlement, before `agent.settled`; afterward Orion
rebuilds the agent from the updated file. Finished voice tools are custom history entries,
rendered in the transcript but excluded from model context.

Four client tools run through `voice.tool`: `db_query`, `db_mutate`, `browser`, and `orion_task`.
Database operations share farm role checks, the one-wearable rule and undo snapshots; `params`
may be an object or JSON object text. Browser actions use the text agent's browser session and
emit JPEG `browser.view` pictures with an optional highlight box. The app itself owns the fifth
tool, `app`, which operates its screen. `orion_task` starts the normal chat agent and answers
immediately; completion follows as `tool.end` and `voice.note`. Other tools exceeding twelve
seconds also answer immediately and deliver their result later. The app forwards notes as
contextual user updates without saving another turn.

`--mock-model` uses a deterministic ElevenLabs protocol peer with a greeting, client-tool
calls and text responses, without audio. Herd answers use the real database result. Stopping,
signing out, the owner protocol socket disconnecting or Orion shutting down ends the call.
Closing only the SDK socket closes its upstream, while final turn and tool reports remain
accepted until the call ends.

In the app, `features/voice` owns the call. `VoiceProvider` (mounted in `AppProviders`) starts
the SDK against the local socket and serves the SDK's audio worklets from
`public/vendor/elevenlabs`, because the desktop content security policy allows neither blob nor
CDN scripts. Without a microphone it falls back to a text-only call. The call is shown in three
places: the Home widget, the pinned stage in chat, and a floating dock on every other screen.
While a call is live in the open conversation, the chat composer sends into the call instead of
starting a chat run. `features/guide` runs the `app` tool on the app's own screen (a numbered
listing of what is visible, highlight, pointer, click and navigation; buttons that destroy or
sign out are highlight-only) and renders the `browser.view` pictures.

## Building the desktop app

`scripts/build-desktop.sh` builds the native app for the current machine (Orion sidecar via
`bun build --compile`, pinned go2rtc, debug `tauri build`); it needs Rust and the Tauri
prerequisites. CI builds and smoke-tests the same app on Windows, macOS and Linux, and the release
workflow produces the signed installers.
