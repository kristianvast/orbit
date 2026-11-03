# Core

Core is Orbit's optional cloud side. Orbit works fully offline without it; when a farm connects
to Core, its data is backed up and shared across that farm's Orbit installs, and Orion can use
the metered LLM gateway instead of the farmer's own API key.

```
Orbit install (@orbit/sync)                       Core
  outbox ── POST /v1/changes ──▶ @core/api ──▶ Postgres 17 (wal_level=logical)
  SQLite ◀── GET /v1/shape ───── @core/api ◀── Electric ◀── logical replication
  Orion  ─── POST /v1/llm/* ───▶ @core/api ──▶ LLM provider (metered per farm)
```

- **Postgres** holds the synced tables from `@orbit/schema/pg` and Core-only tables
  (`api_tokens`, `farm_budgets`, `llm_usage`, `__core_migrations`).
- **Electric** (electricsql/electric, Apache-2.0) streams _shapes_ (one table plus a `where`
  filter) out of Postgres over HTTP. It is read-only and never exposed publicly.
- **@core/api** (Bun + Hono, `core/api`) is the only public service. It authenticates each farm,
  proxies shapes with the farm filter forced on, applies writes with last-writer-wins by HLC, and
  meters LLM usage.

## Endpoints

All `/v1/*` routes need `Authorization: Bearer <farm token>`. The token decides which farm the
request is for; clients never choose `farm_id`.

| Route                                                                   | Purpose                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                                                          | Liveness plus a `select 1` database check. No auth.                                                                                                                                           |
| `GET /v1/shape?table=<synced table>&offset=<o>[&handle=&live=&cursor=]` | Proxies to Electric with `where=farm_id = $1`, `params[1]=<token farm>`, `replica=full` and the Electric secret. Electric's headers (`electric-handle`, `electric-offset`, ...) pass through. |
| `POST /v1/changes`                                                      | Body `{ changes: [{ seq, op, table, rowId, hlc, row }] }`, at most 1000 per request. Returns `{ results: [{ seq, status, error? }] }`.                                                        |
| `POST /v1/llm/<provider path>`                                          | Forwards to `LLM_UPSTREAM_URL/<provider path>` using Core's key, after checking the farm's monthly budget.                                                                                    |

`POST /v1/changes` returns one status per change:

- `applied`: the row was written.
- `stale`: Core already has an equal or newer HLC. The client still marks the row as acked.
- `rejected`: the row failed validation (wrong farm, bad enum or type, delete without
  `deleted_at`, wearable flag that contradicts the device kind, or bad HLC). This is terminal.
- `conflict`: a concurrent binding race. The client retries.

Device bindings follow the domain rule that an animal wears a collar, a bolus or an ear tag
sensor, never two at once, and that a device is bound to only one animal at a time. When a pushed
active binding conflicts with an existing one, the binding with the newer HLC stays active and
Core ends the older one, stamping it with a fresh `cloud` HLC so the change syncs back to every
install.

## Run locally

Docker is for a server or CI, not the developer Mac (compute rule). The tests need no Docker,
because they run Postgres in-process through PGlite:

```sh
bun run --filter '@core/api' test
```

To run the full stack on a machine that has Docker:

```sh
cp core/.env.example core/.env   # then set ELECTRIC_SECRET and the LLM settings
docker compose -f core/docker-compose.yml --env-file core/.env up --build
curl localhost:8080/healthz
```

The API runs migrations on start: first the `@orbit/schema` Postgres migrations, then
`core/api/migrations/*.sql`. The admin CLI needs `DATABASE_URL`:

```sh
bun core/api/src/cli.ts migrate
bun core/api/src/cli.ts issue-token <farm-uuid> "Barn PC"   # prints the token once; only its SHA-256 is stored
bun core/api/src/cli.ts set-budget <farm-uuid> 5000000
```

Paste the token into Orbit's sync settings. Orion then passes it to
`createSyncEngine({ coreUrl, token, ... })`.

## Environment

| Variable                   | Used by       | Notes                                                                                                             |
| -------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`             | api, cli      | Postgres URL. On Cloud Run use the Cloud SQL socket form `postgres://user:pass@/orbit?host=/cloudsql/<instance>`. |
| `ELECTRIC_URL`             | api           | Internal Electric URL, e.g. `http://electric:3000`.                                                               |
| `ELECTRIC_SECRET`          | api, electric | Shared secret; Electric rejects shape requests that lack it. **Secret.**                                          |
| `CORE_STATIC_TOKENS`       | api           | Development only: `token:farm-uuid,...`. Leave empty in production.                                               |
| `LLM_UPSTREAM_URL`         | api           | e.g. `https://api.openai.com` or `https://api.anthropic.com`. Without it `/v1/llm/*` returns 503.                 |
| `LLM_UPSTREAM_API_KEY`     | api           | Core's provider key. **Secret.**                                                                                  |
| `LLM_UPSTREAM_AUTH`        | api           | `authorization` (Bearer) or `x-api-key`.                                                                          |
| `LLM_MONTHLY_TOKEN_BUDGET` | api           | Default per-farm monthly token budget (input + output). Default 2,000,000.                                        |
| `CORE_MIGRATE_ON_START`    | api           | `false` turns off migrating on boot.                                                                              |
| `PORT`                     | api           | Default 8080.                                                                                                     |
| `CORE_VERSION`             | api           | Reported by `/healthz`.                                                                                           |

Keep these in Secret Manager: the Postgres password (inside `DATABASE_URL`), `ELECTRIC_SECRET`
and `LLM_UPSTREAM_API_KEY`.

## Deploy to GCP (recommended: Cloud Run + Cloud SQL)

1. **Cloud SQL for PostgreSQL 17.**
   - Set the database flag `cloudsql.logical_decoding=on`. This is the Cloud SQL equivalent of
     `wal_level=logical`, and changing it restarts the instance.
   - Create the database `orbit` and a user for the API.
   - Create a second user for Electric and give it the `REPLICATION` attribute:
     `ALTER USER electric WITH REPLICATION;`.
   - Give the Electric user ownership of the synced tables, or at least `SELECT` on them, so it
     can create its publication.
2. **Electric.** Run it with `min-instances=1`, `max-instances=1`, CPU always allocated, and
   **no public ingress** (internal only).
   - Cloud Run works for this. A small Compute Engine VM running the container is the simplest
     alternative.
   - Electric keeps its shape log in `ELECTRIC_STORAGE_DIR`. On Cloud Run that directory is
     ephemeral; this is acceptable because Electric rebuilds shapes after a restart and clients
     receive `409 must-refetch` and resync idempotently (LWW). Mount a persistent disk to avoid
     the resync cost.
   - Connect it to Cloud SQL over a private IP (Serverless VPC connector). The replication
     protocol needs a direct TCP connection.
3. **@core/api on Cloud Run.**
   - Build `core/api/Dockerfile` with the repo root as the build context, using Cloud Build or
     GitHub Actions (never the dev Mac).
   - Attach the Cloud SQL instance and inject the secrets from Secret Manager.
   - Set `ELECTRIC_URL` to Electric's internal URL.
   - Set the request timeout to at least 60 s so Electric live long-polls and streamed LLM
     responses finish.
4. Run `cli.ts migrate` once, using a Cloud Run job or the API's migrate-on-start. Then issue one
   token per farm install.

## Not built yet

- **Billing.** `llm_usage` records every gateway request (farm, model, input, output and total
  tokens, upstream status). The next step is a monthly job that aggregates per farm and reports
  usage to the billing provider (for example Stripe metered billing), with `farm_budgets` set
  from the farm's plan.
- **Budget accuracy.** The budget is checked before each request, so one in-flight request can
  overshoot it. There is no per-model price weighting and no model allowlist yet.
- **Token management.** No admin UI or API for tokens beyond the CLI. Revocation works by setting
  `api_tokens.revoked_at`.
- **Farm onboarding.** No signup flow creates the `farms` row; the first Orbit push creates it.
- **Rate limiting** per token is not implemented.
- **Unverified locally.** The Docker image and compose file have not been run on this machine
  (Docker is not allowed on the dev Mac). Verify them in CI.
