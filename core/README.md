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
token. Billing management, hardware checkout and voice require user sessions. Registration,
login, the price-gated plan catalog and signed Stripe webhooks are public.

| Route                                                                   | Purpose                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`, `GET /healthz`                                           | Liveness plus a `select 1` database check. No auth.                                                                                                                                           |
| `GET /v1/shape?table=<synced table>&offset=<o>[&handle=&live=&cursor=]` | Proxies to Electric with `where=farm_id = $1`, `params[1]=<token farm>`, `replica=full` and the Electric secret. Electric's headers (`electric-handle`, `electric-offset`, ...) pass through. |
| `POST /v1/changes`                                                      | Body `{ changes: [{ seq, op, table, rowId, hlc, row }] }`, at most 1000 per request. Returns `{ results: [{ seq, status, error? }] }`.                                                        |
| `POST /v1/llm/<provider path>`                                          | Forwards to `LLM_UPSTREAM_URL/<provider path>` using Core's key, after checking the farm's monthly budget.                                                                                    |
| `GET /v1/voice/live`                                                    | Session-authenticated, metered Gemini Live WebSocket for existing desktop clients.                                                                                                            |
| `GET /v1/voice/agent`                                                   | Session-authenticated, metered ElevenLabs Agents WebSocket; requires farm membership.                                                                                                         |

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
For local accounts, run `MAIL_PROVIDER=log bun run --filter '@core/api' dev` from the repository
root. No database or mail credentials are needed. Verification messages appear in that terminal
as `[mail:verify_email]`, including `/account/?verify=<code>`. Open the link on the local website,
or POST `{"token":"<code>"}` to `http://localhost:8787/v1/auth/verify-email`.

## Accounts and email

Sign-up (`POST /v1/auth/register`) requires `acceptTerms: true` and records the terms version
(`TERMS_VERSION`) and the optional `dataConsent` choice. Core emails a verify link to
`PUBLIC_SITE_URL/account/?verify=<code>`; plan checkout and invite acceptance need a confirmed
address. Email links are single-use, stored as SHA-256 hashes, and expire (verify 48 h, reset 1 h).
Passwords must be 8 to 256 characters for registration, reset and password changes.

`POST /v1/auth/google` accepts `{credential, acceptTerms?, dataConsent?, deviceName?}`, where
`credential` is the Google Identity Services ID token. Core verifies its RS256 signature,
issuer, configured client audience and timestamps (60 seconds of clock skew), and requires
a verified email. Existing Google subjects sign in first; otherwise a matching lowercase email
links the account. New accounts require `acceptTerms: true`, record the consent choice, and have
no password or verification email. Password reset can add a password later. Returns
`{user, session, created}` with 201 for a new account and 200 otherwise, using the same user and
session fields as password login. Errors include 503 `google_disabled`, 401 `invalid_google_token`,
400 `google_email_unverified`, and 400 `terms_required`.

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

## Feedback and shared builds

`POST /v1/feedback` accepts an optional user session and
`{kind:"issue"|"idea"|"other",message,contactEmail?,appVersion?,os?,locale?,diagnostics?}`.
Messages are 1 to 5000 characters; diagnostics are at most 20000. It returns `201 {id}`.
Each user, or client IP for anonymous requests, can send 20 messages per rolling 24 hours
(429 `rate_limited` thereafter). The client IP follows the Cloud Run convention: the last
`X-Forwarded-For` hop. Without that header, anonymous callers share the `unknown` bucket.
`feedback_rate_events` stores hashed anonymous identities and timestamps; an advisory transaction
lock makes the check and insert atomic across instances. Expired events for an identity are pruned
when it next submits. No raw IP is retained.

`POST /v1/submissions` requires a user session and accepts
`{kind:"page"|"connector"|"skill",name,title,description,appVersion?,files:[{path,content}]}`.
Names match `^[a-z0-9][a-z0-9-]{0,47}$`; titles are 1 to 120 characters and descriptions
1 to 2000. Include 1 to 60 UTF-8 text files, at most 512 KiB of content combined
(oversize returns 413). Paths are at most 200 characters, relative, without `..`, and each
segment matches `^[A-Za-z0-9_][A-Za-z0-9._-]*$`. Returns `201 {id,status:"pending"}`.
For either POST, `x-orbit-farm` is recorded only when the signed-in user is a member.
`GET /v1/submissions` requires a session and returns the caller's own builds, newest first:
`{submissions:[{id,kind,name,title,status,reviewNote,createdAt,reviewedAt}]}`.

Set `CORE_FEEDBACK_EMAIL` to receive `feedback_received` and `submission_received` emails
through the configured mailer. Submission notices contain paths, never file bodies.
Mail failures are logged after the database write and do not fail either request.

Set the secret `CORE_ADMIN_TOKEN` to enable the owner inbox at `/admin` and these bearer-token
routes (all return 404 while disabled; wrong tokens return 401):

| Route                               | Body / response                               |
| ----------------------------------- | --------------------------------------------- |
| `GET /v1/admin/feedback?status=`    | `{feedback:[...]}` with full feedback rows    |
| `PATCH /v1/admin/feedback/:id`      | `{status:"new"                                | "read"     | "done"}`; returns updated row              |
| `GET /v1/admin/submissions?status=` | `{submissions:[...]}` with metadata, no files |
| `GET /v1/admin/submissions/:id`     | Full submission row including `files`         |
| `PATCH /v1/admin/submissions/:id`   | `{status:"pending"                            | "approved" | "rejected",reviewNote?}`; updated metadata |

Response fields use camelCase and ISO-8601 timestamps. Reviewing sets `reviewedAt`; returning to
pending clears it. Omitting `reviewNote` preserves it; an empty string clears it. The standalone
admin page keeps the token in `sessionStorage` until forgotten or the tab closes. Farmer text
is displayed as text, including file content; builds are never executed or published.

For Cloud Run provisioning, pass `SECRET_CORE_ADMIN_TOKEN=<strong token>` and optionally
`CORE_FEEDBACK_EMAIL=<address>`. The admin secret is mounted only when a real value exists;
the provisioning placeholder never enables the admin routes.

## Billing and Gemini

`GET /v1/billing/plans` returns `{currency:"eur",locked:false,trialDays:30,plans,hardware}` publicly:

| Plan               | Cameras | EUR/month | EUR/year | Orion tokens/month | Voice minutes/month |
| ------------------ | ------- | --------- | -------- | ------------------ | ------------------- |
| Free (`free`)      | 0       | 0         | 0        | 0                  | 0                   |
| Orion (`orion`)    | 0       | 20        | 200      | 2,000,000          | 30                  |
| 2 cameras (`cam2`) | 2       | 49        | 490      | 3,000,000          | 60                  |
| 4 cameras (`cam4`) | 4       | 75        | 750      | 5,000,000          | 100                 |
| 6 cameras (`cam6`) | 6       | 95        | 950      | 8,000,000          | 150                 |

The Pecorva box is EUR 920 and a Tested camera is EUR 150 once. API prices are euros;
Stripe amounts are cents. Paid allowances reset at the UTC calendar month start.
Each farm gets one free Orion pool (2 million tokens and 30 voice minutes) for 30 days from
the earliest account creation date among its owners. During this month its plan remains `free`
and usage counts from that date, across calendar month boundaries. The month is granted only once
that owner's email address is confirmed; until then the gateway answers 402 `plan_required` with
a confirm-your-email message. Farms without an owner have no free month. A paid active or
trialing subscription supersedes it.

Set `STRIPE_SECRET_KEY` and run `bun run --filter '@core/api' stripe:setup` once per Stripe
account. It idempotently creates products and EUR lookup prices. Configure Stripe to send
`checkout.session.completed`, `customer.subscription.created|updated|deleted`, and
`checkout.session.async_payment_succeeded|failed`, and `invoice.payment_failed` to
`POST /v1/billing/webhook`, then set `STRIPE_WEBHOOK_SECRET`.
Signatures expire after five minutes; event claims and subscription effects commit together.

Session routes take `Authorization: Bearer <session>` and `x-orbit-farm`:

- `POST /v1/billing/checkout`: `{plan:"orion"|"cam2"|"cam4"|"cam6",interval:"month"|"year",box?,cameras?,successUrl?,cancelUrl?}`.
  Hardware quantities are whole numbers (`box` 0–20, `cameras` 0–64). Nonzero quantities add
  one-time hardware to the same subscription Checkout Session and collect shipping.
- `POST /v1/billing/portal`: `{returnUrl?}`. Checkout and portal require owner or manager.
- `GET /v1/billing/status`: subscription state plus token and voice usage for any member.
  `trialEndsAt` is an ISO timestamp during the free month, otherwise null.
- `POST /v1/billing/hardware-checkout`: `{box:0,cameras:1,successUrl?,cancelUrl?}` with shipping
  collection. Requires a user session, with no farm header. Buyer email comes from the session.
  Paid hardware orders and receipts are recorded once for either session mode.

Redirect defaults are `BILLING_SUCCESS_URL` and `BILLING_CANCEL_URL`. Browser access uses
`CORE_CORS_ORIGINS`, a comma-separated list (dev default `http://localhost:3000`).

With `LLM_UPSTREAM_AUTH=google` and `GCP_PROJECT`, Core derives the global Vertex
OpenAI endpoint, strips Orion's leading `/v1`, and maps `orbit-default` to
`LLM_DEFAULT_MODEL` (default `google/gemini-3.8-flash`). The `orbit-small` alias, used for short background jobs such as naming a conversation, maps to `LLM_SMALL_MODEL` (default `google/gemini-3.5-flash-lite`, falling back to the default model when unset). Google access tokens are cached
until 60 seconds before expiration. Auth uses GCP metadata on Cloud Run, then a
`GOOGLE_APPLICATION_CREDENTIALS` service account JWT, otherwise development-only
`gcloud auth application-default print-access-token`.

Active or trialing paid subscriptions supply token allowances; `farm_budgets` overrides
the token allowance. After the free month, no paid plan returns 402 `plan_required`; the farmer
can subscribe to Orion or a camera plan, or use their own provider key. A consumed allowance
returns 429 `budget_exceeded`. Legacy API-token principals keep the historical
`LLM_MONTHLY_TOKEN_BUDGET` fallback and farm override behavior for existing installs.

`GET /v1/voice/live` upgrades a session-authenticated WebSocket and proxies Gemini Live JSON
frames. Core forces `VOICE_MODEL=gemini-3.8-live` and `VOICE_LOCATION=us-central1`; clients
send BidiGenerateContent setup, audio and tool-response frames. OAuth stays in the upstream
authorization header. Connected seconds persist to `voice_usage` every second and on close;
concurrent connections share the allowance, including the free month's single pool.
Reaching it closes with 4402. A farm without a paid plan or free month receives HTTP 402
before upgrade. Upstream disconnection ends the client connection.

`GET /v1/voice/agent` uses the same session, farm membership and voice allowance checks.
Set `VOICE_AGENT_ID` to the Orbit ElevenLabs agent and reuse `ELEVENLABS_API_KEY`.
Core fetches a signed WebSocket URL with its key; neither credential reaches the client.
ElevenLabs text frames pass through verbatim in both directions, including queued client
frames sent before the upstream opens. Usage is stored as `elevenlabs:<agentId>` in
`voice_usage`, sharing the Gemini allowance and 4402 close behavior. Either socket closing
ends the call. Missing key or agent configuration returns 503 `not_configured`; a failed
signed-URL request returns 502 `upstream_error` before upgrade and creates no usage row.
The `/v1/voice/live` endpoint remains available for released desktop clients.

The Orbit agent itself (what Orion is told, its voice, and its five client tools) is defined in
`api/src/orion-voice-agent.ts`. `bun run --filter '@core/api' voice:setup -- --print` shows what
would be sent. With `ELEVENLABS_API_KEY` set, `voice:setup` creates the agent and its tools in
ElevenLabs and prints the id to use as `VOICE_AGENT_ID`; with `VOICE_AGENT_ID` also set it
updates that agent and only the tools that agent already uses. A run that fails removes the tools
it created. The tools run on the farm's own computer, so nothing in ElevenLabs reaches farm data
directly. `deploy/provision.sh` carries the agent's id as the default `VOICE_AGENT_ID`.

The remaining local-stack instructions below apply to a server or CI machine.

The tests need no Docker, because they run Postgres in-process through PGlite:

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
bun core/api/src/cli.ts issue-token <farm-uuid> "Farm PC"   # prints the token once; only its SHA-256 is stored
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
| `CORE_ADMIN_TOKEN`         | api           | Optional owner review token. Empty disables `/admin` and `/v1/admin/*`. **Secret.**                               |
| `CORE_FEEDBACK_EMAIL`      | api           | Optional address for feedback and shared-build notices through `MAIL_PROVIDER`.                                   |
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
| `GOOGLE_CLIENT_IDS`        | api           | Comma-separated Google OAuth client IDs accepted by `/v1/auth/google`; unset disables it (503).                   |
| `GCP_PROJECT`              | api           | With `LLM_UPSTREAM_AUTH=google`: Vertex project. Also `LLM_DEFAULT_MODEL`, `VOICE_MODEL`, `VOICE_LOCATION`.       |
| `ELEVENLABS_API_KEY`       | api           | ElevenLabs server API key, shared by the website demo and authenticated agent gateway. **Secret.**                |
| `VOICE_AGENT_ID`           | api           | Orbit ElevenLabs agent ID for `/v1/voice/agent`; unset disables the gateway (503).                                |

Keep these in Secret Manager: the Postgres password (inside `DATABASE_URL`), `ELECTRIC_SECRET`,
the Stripe secrets, `MAIL_API_KEY`, `CORE_ADMIN_TOKEN` and `LLM_UPSTREAM_API_KEY`.

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
