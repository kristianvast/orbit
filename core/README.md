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

Farm routes accept a user session with `x-orbit-farm` (membership required), or a legacy farm
token. Billing management and voice require user sessions. Registration, login, plans,
hardware checkout and signed Stripe webhooks are public.

| Route                                                                   | Purpose                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`, `GET /healthz`                                           | Liveness plus a `select 1` database check. No auth.                                                                                                                                           |
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

For API development without Docker, use `bun run --filter '@core/api' dev`. It listens on
port 8787 (override `PORT`) and migrates PGlite persisted in `core/api/.dev-data/`, which is
gitignored. Export configuration first, or use `bun --env-file=core/.env core/api/src/dev.ts`.
Electric is optional for this runner; shape requests still need a real Electric instance.

## Accounts and email

Sign-up (`POST /v1/auth/register`) requires `acceptTerms: true` and records the terms version
(`TERMS_VERSION`) and the optional `dataConsent` choice. Core emails a verify link to
`PUBLIC_SITE_URL/account/?verify=<code>`; plan checkout and invite acceptance need a confirmed
address. Email links are single-use, stored as SHA-256 hashes, and expire (verify 48 h, reset 1 h).

| Route                                                     | Purpose                                                                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/auth/verify-email` `{token}`                    | Confirms the address (410 `link_invalid` when used or expired).                                                                                                          |
| `POST /v1/auth/resend-verification`                       | New verify link, at most one a minute.                                                                                                                                   |
| `POST /v1/auth/password-reset` `{email}`                  | Always 202, so it never reveals accounts; at most 3 links an hour.                                                                                                       |
| `POST /v1/auth/password-reset/confirm` `{token,password}` | Sets the password and signs out every session.                                                                                                                           |
| `POST /v1/me/password` `{currentPassword,newPassword}`    | Changes the password and signs out other sessions.                                                                                                                       |
| `GET /v1/me/sessions`, `DELETE /v1/me/sessions/:id`       | Lists and revokes signed-in devices.                                                                                                                                     |
| `GET /v1/me/export`                                       | JSON export of the account (profile, sessions, memberships, invites, orders).                                                                                            |
| `DELETE /v1/me` `{password}`                              | Deletes the account; cloud copies of farms it owns alone are wiped. A running plan must be cancelled and shared farms need another owner first. Invoices stay in Stripe. |
| `POST /v1/farms` `{id,name,adopt}`                        | An Orbit install takes over an empty cloud farm the caller owns (members, plan, usage), e.g. one bought on the website.                                                  |

Failed sign-ins are counted per email in Postgres (`login_failures`), so the throttle holds across
instances. `MAIL_PROVIDER` is `resend`, `postmark` or `log` (prints messages, for development);
`src/server.ts` refuses to start without it. Emails: verify, password reset, password changed,
farm invite, plan active (Orbit download and sign-in steps), hardware order receipt, and an
order notice to `ORDERS_EMAIL`.

## Billing and Gemini

`GET /v1/billing/plans` publishes EUR prices: Free, Pen (49/month or 490/year), Barn
(189/month or 1890/year); the box is 920 and a tested camera is 150 once. API prices are
euros; Stripe amounts are cents. Pen includes 3 million Orion tokens and 60 voice minutes
per UTC calendar month; Barn includes 15 million and 300 minutes. Free users bring their
own provider key in Orbit Settings.

Set `STRIPE_SECRET_KEY` and run `bun run --filter '@core/api' stripe:setup` once per Stripe
account. It idempotently creates products and EUR lookup prices. Configure Stripe to send
`checkout.session.completed`, `customer.subscription.created|updated|deleted`, and
`invoice.payment_failed` to `POST /v1/billing/webhook`, then set `STRIPE_WEBHOOK_SECRET`.
Signatures expire after five minutes; event claims and subscription effects commit together.

Session routes take `Authorization: Bearer <session>` and `x-orbit-farm`:

- `POST /v1/billing/checkout`: `{plan:"pen"|"barn",interval:"month"|"year",successUrl?,cancelUrl?}`.
- `POST /v1/billing/portal`: `{returnUrl?}`. Checkout and portal require owner or manager.
- `GET /v1/billing/status`: subscription state plus token and voice usage for any member.
- Public `POST /v1/billing/hardware-checkout`: `{box:0,cameras:1,email?}` with shipping collection.

Redirect defaults are `BILLING_SUCCESS_URL` and `BILLING_CANCEL_URL`. Browser access uses
`CORE_CORS_ORIGINS`, a comma-separated list (dev default `http://localhost:3000`).

With `LLM_UPSTREAM_AUTH=google` and `GCP_PROJECT`, Core derives the global Vertex
OpenAI endpoint, strips Orion's leading `/v1`, and maps `orbit-default` to
`LLM_DEFAULT_MODEL` (default `google/gemini-3.8-flash`). Google access tokens are cached
until 60 seconds before expiration. Auth uses GCP metadata on Cloud Run, then a
`GOOGLE_APPLICATION_CREDENTIALS` service account JWT, otherwise development-only
`gcloud auth application-default print-access-token`.

Active or trialing paid subscriptions supply token allowances; `farm_budgets` overrides
the token allowance. No paid plan returns 402 `plan_required`; a consumed allowance
returns 429 `budget_exceeded`. Legacy API-token principals keep the historical
`LLM_MONTHLY_TOKEN_BUDGET` fallback and farm override behavior for existing installs.

`GET /v1/voice/live` upgrades a session-authenticated WebSocket and proxies Gemini Live JSON
frames. Core forces `VOICE_MODEL=gemini-3.8-live` and `VOICE_LOCATION=us-central1`; clients
send BidiGenerateContent setup, audio and tool-response frames. OAuth stays in the upstream
authorization header. Connected seconds persist to `voice_usage` every second and on close;
concurrent connections share the allowance. Reaching it closes with 4402. An unpaid farm
receives HTTP 402 before upgrade. Upstream disconnection ends the client connection.

The remaining local-stack instructions below apply to a server or CI machine.

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
| `LLM_UPSTREAM_AUTH`        | api           | `google` (Vertex OAuth), `authorization` (Bearer), or `x-api-key`.                                                |
| `LLM_MONTHLY_TOKEN_BUDGET` | api           | Default per-farm monthly token budget (input + output). Default 2,000,000.                                        |
| `CORE_MIGRATE_ON_START`    | api           | `false` turns off migrating on boot.                                                                              |
| `PORT`                     | api           | Default 8080.                                                                                                     |
| `CORE_VERSION`             | api           | Reported by `/healthz`.                                                                                           |
| `STRIPE_SECRET_KEY`        | api           | Stripe key; billing routes are off without it. **Secret.**                                                        |
| `STRIPE_WEBHOOK_SECRET`    | api           | Signing secret of the Stripe webhook endpoint. **Secret.**                                                        |
| `STRIPE_AUTOMATIC_TAX`     | api           | `true` enables Stripe Tax on checkout.                                                                            |
| `BILLING_SUCCESS_URL`      | api           | Default checkout success redirect. `BILLING_CANCEL_URL` is the cancel redirect.                                   |
| `CORE_CORS_ORIGINS`        | api           | Comma-separated browser origins.                                                                                  |
| `MAIL_PROVIDER`            | api           | `resend`; needs `MAIL_API_KEY` (**secret**) and `MAIL_FROM`.                                                      |
| `PUBLIC_SITE_URL`          | api           | Site linked from mails. `ORBIT_DOWNLOAD_URL` is the download link; `ORDERS_EMAIL` gets hardware orders.           |
| `TERMS_VERSION`            | api           | Current terms version.                                                                                            |
| `GCP_PROJECT`              | api           | With `LLM_UPSTREAM_AUTH=google`: Vertex project. Also `LLM_DEFAULT_MODEL`, `VOICE_MODEL`, `VOICE_LOCATION`.       |

Keep these in Secret Manager: the Postgres password (inside `DATABASE_URL`), `ELECTRIC_SECRET`,
the Stripe secrets, `MAIL_API_KEY` and `LLM_UPSTREAM_API_KEY`.

## Deploy to GCP (Cloud Run + Cloud SQL)

Everything lives in project `agrointel-dd8f6`, region `europe-north1`, one set per environment
(`staging`, `production`). Scripts in `core/deploy/` only run light `gcloud` commands locally;
images are built on Cloud Build or in GitHub Actions.

**`ENV=<env> core/deploy/provision.sh`** is idempotent and never deletes anything. It creates or
converges:

- Artifact Registry repo `orbit-core` (image `core-api`).
- Cloud SQL Postgres 17 `orbit-core-<env>` with `cloudsql.logical_decoding=on`, database and
  user `orbit` (granted `REPLICATION` by the one-shot Cloud Run job `orbit-core-<env>-dbinit`).
  Staging is `db-f1-micro` without backups; production is `db-custom-1-3840` with daily backups,
  PITR and deletion protection.
- Secrets `orbit-core-<env>-{DB_PASSWORD,DATABASE_URL,ELECTRIC_DATABASE_URL,ELECTRIC_SECRET,
  STRIPE_SECRET_KEY,STRIPE_WEBHOOK_SECRET,MAIL_API_KEY}`. Database and Electric secrets are
  generated; the others get the placeholder `unset` unless passed as `SECRET_<NAME>=...`.
- Runtime service account `orbit-core-<env>` (Cloud SQL client, secret accessor, Vertex user).
- Electric `orbit-electric-<env>`: Cloud Run, internal ingress, one always-on instance, with a
  `cloud-sql-proxy` sidecar for the replication TCP connection. Its shape log is ephemeral;
  after a restart clients get `409 must-refetch` and resync.
- VPC `orbit-<env>` with Private Google Access and a private `run.app` DNS zone. The API uses
  Direct VPC egress (private ranges) into it, which is what makes its calls to Electric count as
  internal.
- API `orbit-core-<env>`: public Cloud Run, Cloud SQL attached, secrets as env, 3600 s timeout
  (voice WebSockets). It migrates on start. Non-secret settings default to staging values; production
  requires `PUBLIC_SITE_URL`, `CORE_CORS_ORIGINS`, `BILLING_SUCCESS_URL`, `BILLING_CANCEL_URL`.
- GitHub Actions access: workload identity pool `orbit-github` / provider `github` (repo
  `kristianvast/orbit` only) and deployer `orbit-core-deployer` (Cloud Run developer, Artifact
  Registry writer).

On the first run it builds an image with `core/deploy/build.sh`. Later runs keep the running
image unless `IMAGE=` is set.

**Shipping code.** `.github/workflows/core-deploy.yml` runs the `@core/api` typecheck and tests,
builds the image in the runner, runs `gcloud run deploy orbit-core-<env>` (image and
`CORE_VERSION` only) and smoke-tests `/health`. Cloud Run's front end reserves paths ending in
`z` on `run.app`, so `/healthz` never reaches the container there; `/health` is the same handler. Pushes to `main` that touch `core/**` or
`packages/schema/**` deploy staging. Run the workflow by hand to choose an environment;
production waits for approval in the `production` GitHub Environment. Repo variables:
`GCP_PROJECT`, `GCP_REGION`, `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA`. To ship the local working tree
without Actions, run `ENV=staging core/deploy/deploy.sh` (Cloud Build, then deploy, then smoke).

**Stripe.** `ENV=<env> core/deploy/stripe-webhook.sh` registers `<api>/v1/billing/webhook`
once, using the key in that environment's `STRIPE_SECRET_KEY` secret. It stores the signing
secret, rolls the API, and runs `stripe-setup.ts` if prices are missing.

After deploying, issue one token per farm install (`cli.ts issue-token`).

## Operational limits

- **Budget accuracy.** The budget is checked before each request, so one in-flight request can
  overshoot it. There is no per-model price weighting and no model allowlist yet.
- **Token management.** No admin UI or API for tokens beyond the CLI. Revocation works by setting
  `api_tokens.revoked_at`.
- **Rate limiting** per token is not implemented.
- **Unverified locally.** The Docker image and compose file have not been run on this machine
  (Docker is not allowed on the dev Mac). Verify them in CI.
