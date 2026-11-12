#!/usr/bin/env bash
# Provision (or re-converge) one Orbit Core environment on GCP. Safe to re-run: every step
# checks before it creates, and nothing is ever deleted.
#
#   ENV=staging    core/deploy/provision.sh
#   ENV=production PUBLIC_SITE_URL=https://... CORE_CORS_ORIGINS=https://... \
#     BILLING_SUCCESS_URL=... BILLING_CANCEL_URL=... core/deploy/provision.sh
#
# Optional:
#   REGION (default europe-north1), PROJECT (default agrointel-dd8f6)
#   IMAGE=<ref>   deploy this API image instead of the running one (first run builds one)
#   SECRET_<NAME>=<value>  store a new version of secret <NAME> if it differs, e.g.
#                          SECRET_MAIL_API_KEY, SECRET_STRIPE_SECRET_KEY, SECRET_STRIPE_WEBHOOK_SECRET
# Secrets without a known value get the placeholder "unset"; values are never printed.
set -euo pipefail

ENV="${ENV:?set ENV=staging|production}"
PROJECT="${PROJECT:-agrointel-dd8f6}"
REGION="${REGION:-europe-north1}"
GITHUB_REPO="${GITHUB_REPO:-kristianvast/orbit}"
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$ENV" in
staging)
  SQL_TIER=db-f1-micro
  # f1-micro defaults to 25 connections; Electric + API rollouts need more headroom.
  SQL_FLAGS=cloudsql.logical_decoding=on,max_connections=50
  SQL_EXTRA=(--no-backup)
  SUBNET_RANGE=10.80.0.0/24
  API_MIN=0 API_MAX=2
  # db-f1-micro allows ~22 user connections: API 4 x (2 instances + 1 during rollout) + Electric.
  API_DB_POOL=4 ELECTRIC_DB_POOL=4
  ;;
production)
  SQL_TIER=db-custom-1-3840
  SQL_FLAGS=cloudsql.logical_decoding=on
  SQL_EXTRA=(--backup-start-time=02:00 --enable-point-in-time-recovery
    --retained-backups-count=14 --retained-transaction-log-days=7 --deletion-protection)
  SUBNET_RANGE=10.81.0.0/24
  API_MIN=1 API_MAX=10
  API_DB_POOL=5 ELECTRIC_DB_POOL=10
  : "${PUBLIC_SITE_URL:?production needs PUBLIC_SITE_URL}"
  : "${CORE_CORS_ORIGINS:?production needs CORE_CORS_ORIGINS}"
  : "${BILLING_SUCCESS_URL:?production needs BILLING_SUCCESS_URL}"
  : "${BILLING_CANCEL_URL:?production needs BILLING_CANCEL_URL}"
  ;;
*)
  echo "ENV must be staging or production" >&2
  exit 2
  ;;
esac

# Non-secret API configuration (override any of these from the environment).
CORE_CORS_ORIGINS="${CORE_CORS_ORIGINS:-http://localhost:3000,https://pecorva.com,https://www.pecorva.com,http://127.0.0.1:3000,http://localhost:4317}"
# Public website voice demo (src/voice-demo.ts). The API key is the project-level secret
# ELEVENLABS_API_KEY, mounted only when it exists; without it the endpoint answers 503.
ELEVENLABS_AGENT_ID="${ELEVENLABS_AGENT_ID:-agent_4301m706m15yez7vmk8k0vc8ebea}"
# The Orbit app's voice agent (src/orion-voice-agent.ts, created by `voice:setup`). It uses the
# same API key; without the id /v1/voice/agent answers 503.
VOICE_AGENT_ID="${VOICE_AGENT_ID:-agent_9801m76gmvhke6pbeqm50xq0xp74}"
ELEVENLABS_VOICE_MALE="${ELEVENLABS_VOICE_MALE:-iP95p4xoKVk53GoZ742B}"
BILLING_SUCCESS_URL="${BILLING_SUCCESS_URL:-http://localhost:3000/account/?checkout=success}"
BILLING_CANCEL_URL="${BILLING_CANCEL_URL:-http://localhost:3000/account/?checkout=cancel}"
PUBLIC_SITE_URL="${PUBLIC_SITE_URL:-http://localhost:3000}"
MAIL_FROM="${MAIL_FROM:-Pecorva <no-reply@agrointel.no>}"
ORBIT_DOWNLOAD_URL="${ORBIT_DOWNLOAD_URL:-https://github.com/kristianvast/orbit/releases/latest}"
ORDERS_EMAIL="${ORDERS_EMAIL:-kristian@agrointel.no}"
CORE_FEEDBACK_EMAIL="${CORE_FEEDBACK_EMAIL:-}"
STRIPE_AUTOMATIC_TAX="${STRIPE_AUTOMATIC_TAX:-false}"
TERMS_VERSION="${TERMS_VERSION:-2026-11}"
ELECTRIC_IMAGE="${ELECTRIC_IMAGE:-electricsql/electric:1.8.1}"
SQL_PROXY_IMAGE="${SQL_PROXY_IMAGE:-gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.27.0}"

# Resource names.
AR_REPO=orbit-core
SQL_INSTANCE="orbit-core-$ENV"
DB_NAME=orbit
DB_USER=orbit
NETWORK="orbit-$ENV"
DNS_ZONE="orbit-$ENV-run-app"
RUNTIME_SA_NAME="orbit-core-$ENV"
DEPLOYER_SA_NAME=orbit-core-deployer
WIF_POOL=orbit-github
WIF_PROVIDER=github
ELECTRIC_SERVICE="orbit-electric-$ENV"
API_SERVICE="orbit-core-$ENV"
DBINIT_JOB="orbit-core-$ENV-dbinit"
LABELS="app=orbit-core,env=$ENV"
PLACEHOLDER="unset"
# Cloud Run's Google front end reserves some paths ending in "z" (/healthz never reaches the
# container on run.app), so smoke-test the /health alias (same handler: liveness + select 1).
SMOKE_PATH="${SMOKE_PATH:-/health}"

log() { printf '==> %s\n' "$*" >&2; }
quiet() { "$@" >/dev/null 2>&1; }
g() { gcloud --project "$PROJECT" --quiet "$@"; }

PROJECT_NUMBER="$(g projects describe "$PROJECT" --format='value(projectNumber)')"
RUNTIME_SA="$RUNTIME_SA_NAME@$PROJECT.iam.gserviceaccount.com"
DEPLOYER_SA="$DEPLOYER_SA_NAME@$PROJECT.iam.gserviceaccount.com"
SQL_CONN="$PROJECT:$REGION:$SQL_INSTANCE"

secret_id() { echo "orbit-core-$ENV-$1"; }
secret_ensure() {
  local id
  id="$(secret_id "$1")"
  quiet g secrets describe "$id" ||
    g secrets create "$id" --replication-policy=user-managed --locations="$REGION" --labels="$LABELS" >/dev/null
}
# Prints the latest value (for capture only) or fails when there is none.
secret_get() { g secrets versions access latest --secret "$(secret_id "$1")" 2>/dev/null; }
# Adds a version only when the value changed. Value comes from $2, never from argv of gcloud.
secret_set() {
  local current
  current="$(secret_get "$1" || true)"
  [[ "$current" == "$2" ]] && return 0
  printf '%s' "$2" | g secrets versions add "$(secret_id "$1")" --data-file=- >/dev/null
  log "secret $(secret_id "$1"): new version"
}
secret_has_real_value() {
  local v
  v="$(secret_get "$1")" || return 1
  [[ -n "$v" && "$v" != "$PLACEHOLDER" ]]
}
# New service accounts take a while to become visible to IAM; retry bindings.
retry() {
  local i
  for i in 1 2 3 4 5 6 7 8; do
    "$@" && return 0
    log "retrying in $((i * 5))s: $1 $2 $3"
    sleep $((i * 5))
  done
  "$@"
}
project_role() {
  retry g projects add-iam-policy-binding "$PROJECT" --member="$1" --role="$2" --condition=None >/dev/null
}

log "WORKING: core-deploy - enable APIs ($PROJECT)"
g services enable run.googleapis.com sqladmin.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com secretmanager.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com aiplatform.googleapis.com \
  compute.googleapis.com dns.googleapis.com

log "Artifact Registry $AR_REPO"
quiet g artifacts repositories describe "$AR_REPO" --location="$REGION" ||
  g artifacts repositories create "$AR_REPO" --location="$REGION" --repository-format=docker \
    --description="Orbit Core images" --labels=app=orbit-core
# build.sh pushes as the project's default Cloud Build service account.
CLOUDBUILD_SA="$(g builds get-default-service-account --format='value(serviceAccountEmail)')"
CLOUDBUILD_SA="${CLOUDBUILD_SA##*/}"
g artifacts repositories add-iam-policy-binding "$AR_REPO" --location="$REGION" \
  --member="serviceAccount:$CLOUDBUILD_SA" --role=roles/artifactregistry.writer >/dev/null

log "Cloud SQL $SQL_INSTANCE ($SQL_TIER)"
if ! quiet g sql instances describe "$SQL_INSTANCE"; then
  log "WORKING: core-deploy - creating Cloud SQL instance (takes ~10 min)"
  g sql instances create "$SQL_INSTANCE" --async --database-version=POSTGRES_17 \
    --edition=ENTERPRISE --tier="$SQL_TIER" --region="$REGION" --availability-type=zonal \
    --storage-type=SSD --storage-size=10 --storage-auto-increase \
    --database-flags="$SQL_FLAGS" "${SQL_EXTRA[@]}" >/dev/null
fi
until [[ "$(g sql instances describe "$SQL_INSTANCE" --format='value(state)')" == RUNNABLE ]]; do
  sleep 15
done
CURRENT_FLAGS="$(g sql instances describe "$SQL_INSTANCE" \
  --format='value[delimiter=","](settings.databaseFlags[].map().extract(name,value).flatten(separator="="))' 2>/dev/null || true)"
if [[ "$(tr ',' '\n' <<<"$CURRENT_FLAGS" | sort | paste -sd, -)" != "$(tr ',' '\n' <<<"$SQL_FLAGS" | sort | paste -sd, -)" ]]; then
  log "setting database flags $SQL_FLAGS (restarts the instance)"
  g sql instances patch "$SQL_INSTANCE" --database-flags="$SQL_FLAGS"
fi
quiet g sql databases describe "$DB_NAME" --instance="$SQL_INSTANCE" ||
  g sql databases create "$DB_NAME" --instance="$SQL_INSTANCE"

log "secrets"
for name in DB_PASSWORD DATABASE_URL ELECTRIC_DATABASE_URL ELECTRIC_SECRET \
  STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET MAIL_API_KEY CORE_ADMIN_TOKEN; do
  secret_ensure "$name"
done

if secret_has_real_value DB_PASSWORD &&
  g sql users list --instance="$SQL_INSTANCE" --format='value(name)' | grep -qx "$DB_USER"; then
  DB_PASSWORD="$(secret_get DB_PASSWORD)"
else
  DB_PASSWORD="$(openssl rand -hex 24)"
  if g sql users list --instance="$SQL_INSTANCE" --format='value(name)' | grep -qx "$DB_USER"; then
    g sql users set-password "$DB_USER" --instance="$SQL_INSTANCE" --password="$DB_PASSWORD" >/dev/null
  else
    g sql users create "$DB_USER" --instance="$SQL_INSTANCE" --password="$DB_PASSWORD" >/dev/null
  fi
  secret_set DB_PASSWORD "$DB_PASSWORD"
fi
secret_set DATABASE_URL "postgres://$DB_USER:$DB_PASSWORD@/$DB_NAME?host=/cloudsql/$SQL_CONN&max=$API_DB_POOL"
# Electric reaches Cloud SQL through the cloud-sql-proxy sidecar (replication needs TCP).
secret_set ELECTRIC_DATABASE_URL \
  "postgresql://$DB_USER:$DB_PASSWORD@127.0.0.1:5432/$DB_NAME?sslmode=disable"
unset DB_PASSWORD
secret_has_real_value ELECTRIC_SECRET || secret_set ELECTRIC_SECRET "$(openssl rand -hex 32)"
for name in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET MAIL_API_KEY; do
  var="SECRET_$name"
  if [[ -n "${!var:-}" ]]; then
    secret_set "$name" "${!var}"
  elif ! secret_get "$name" >/dev/null; then
    secret_set "$name" "$PLACEHOLDER"
  fi
done

log "runtime service account $RUNTIME_SA"
quiet g iam service-accounts describe "$RUNTIME_SA" ||
  g iam service-accounts create "$RUNTIME_SA_NAME" --display-name="Orbit Core $ENV runtime"
for role in roles/cloudsql.client roles/secretmanager.secretAccessor roles/aiplatform.user; do
  project_role "serviceAccount:$RUNTIME_SA" "$role"
done

log "VPC $NETWORK (API egress to internal-only Electric)"
quiet g compute networks describe "$NETWORK" ||
  g compute networks create "$NETWORK" --subnet-mode=custom
quiet g compute networks subnets describe "$NETWORK" --region="$REGION" ||
  g compute networks subnets create "$NETWORK" --network="$NETWORK" --region="$REGION" \
    --range="$SUBNET_RANGE" --enable-private-ip-google-access
# run.app resolves to private.googleapis.com inside this VPC, so calls from the API to
# Electric travel through the VPC and count as internal ingress.
quiet g dns managed-zones describe "$DNS_ZONE" ||
  g dns managed-zones create "$DNS_ZONE" --dns-name=run.app. --visibility=private \
    --networks="$NETWORK" --description="Orbit Core $ENV: run.app via Private Google Access"
quiet g dns record-sets describe '*.run.app.' --type=A --zone="$DNS_ZONE" ||
  g dns record-sets create '*.run.app.' --type=A --ttl=300 --zone="$DNS_ZONE" \
    --rrdatas=199.36.153.8,199.36.153.9,199.36.153.10,199.36.153.11

log "GitHub Actions: workload identity pool + deployer"
quiet g iam workload-identity-pools describe "$WIF_POOL" --location=global ||
  g iam workload-identity-pools create "$WIF_POOL" --location=global --display-name="GitHub Actions"
quiet g iam workload-identity-pools providers describe "$WIF_PROVIDER" --location=global \
  --workload-identity-pool="$WIF_POOL" ||
  g iam workload-identity-pools providers create-oidc "$WIF_PROVIDER" --location=global \
    --workload-identity-pool="$WIF_POOL" --display-name="GitHub $GITHUB_REPO" \
    --issuer-uri=https://token.actions.githubusercontent.com \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.environment=assertion.environment" \
    --attribute-condition="assertion.repository == '$GITHUB_REPO'"
quiet g iam service-accounts describe "$DEPLOYER_SA" ||
  g iam service-accounts create "$DEPLOYER_SA_NAME" --display-name="Orbit Core GitHub deployer"
retry g iam service-accounts add-iam-policy-binding "$DEPLOYER_SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$WIF_POOL/attribute.repository/$GITHUB_REPO" >/dev/null
project_role "serviceAccount:$DEPLOYER_SA" roles/run.developer
retry g artifacts repositories add-iam-policy-binding "$AR_REPO" --location="$REGION" \
  --member="serviceAccount:$DEPLOYER_SA" --role=roles/artifactregistry.writer >/dev/null
retry g iam service-accounts add-iam-policy-binding "$RUNTIME_SA" --role=roles/iam.serviceAccountUser \
  --member="serviceAccount:$DEPLOYER_SA" >/dev/null

log "WORKING: core-deploy - database init job (REPLICATION for Electric)"
g run jobs deploy "$DBINIT_JOB" --region="$REGION" --image=postgres:17-alpine \
  --service-account="$RUNTIME_SA" --set-cloudsql-instances="$SQL_CONN" \
  --set-secrets="PGPASSWORD=$(secret_id DB_PASSWORD):latest" \
  --set-env-vars="PGHOST=/cloudsql/$SQL_CONN,PGUSER=$DB_USER,PGDATABASE=$DB_NAME" \
  --command=psql --args="-v,ON_ERROR_STOP=1,-c,ALTER USER $DB_USER WITH REPLICATION" \
  --max-retries=0 --task-timeout=300 --labels="$LABELS" >/dev/null
# One-time grant: skip once an execution has succeeded.
g run jobs executions list --job="$DBINIT_JOB" --region="$REGION" \
  --format='value(status.succeededCount)' | grep -q '^1$' ||
  g run jobs execute "$DBINIT_JOB" --region="$REGION" --wait >/dev/null

log "WORKING: core-deploy - Electric $ELECTRIC_SERVICE (internal ingress)"
electric_yaml="$(mktemp)"
trap 'rm -f "$electric_yaml"' EXIT
cat >"$electric_yaml" <<YAML
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: $ELECTRIC_SERVICE
  labels: {app: orbit-core, env: $ENV}
  annotations:
    run.googleapis.com/ingress: internal
    run.googleapis.com/invoker-iam-disabled: "true"
spec:
  template:
    metadata:
      labels: {app: orbit-core, env: $ENV}
      annotations:
        autoscaling.knative.dev/minScale: "1"
        autoscaling.knative.dev/maxScale: "1"
        run.googleapis.com/cpu-throttling: "false"
        run.googleapis.com/startup-cpu-boost: "true"
        run.googleapis.com/execution-environment: gen2
        run.googleapis.com/container-dependencies: '{"electric":["cloud-sql-proxy"]}'
    spec:
      serviceAccountName: $RUNTIME_SA
      timeoutSeconds: 300
      containerConcurrency: 1000
      containers:
        - name: electric
          image: $ELECTRIC_IMAGE
          ports: [{name: http1, containerPort: 3000}]
          env:
            - {name: ELECTRIC_STORAGE_DIR, value: /tmp/electric}
            - {name: ELECTRIC_DB_POOL_SIZE, value: "$ELECTRIC_DB_POOL"}
            - name: DATABASE_URL
              valueFrom: {secretKeyRef: {name: $(secret_id ELECTRIC_DATABASE_URL), key: latest}}
            - name: ELECTRIC_SECRET
              valueFrom: {secretKeyRef: {name: $(secret_id ELECTRIC_SECRET), key: latest}}
          resources: {limits: {cpu: "1", memory: 1Gi}}
        - name: cloud-sql-proxy
          image: $SQL_PROXY_IMAGE
          args: ["--port=5432", "--health-check", "--http-address=0.0.0.0", "--http-port=9090", "$SQL_CONN"]
          resources: {limits: {cpu: "1", memory: 512Mi}}
          startupProbe:
            httpGet: {path: /startup, port: 9090}
            periodSeconds: 2
            failureThreshold: 30
YAML
g run services replace "$electric_yaml" --region="$REGION" >/dev/null
ELECTRIC_URL="$(g run services describe "$ELECTRIC_SERVICE" --region="$REGION" --format='value(status.url)')"

log "WORKING: core-deploy - API $API_SERVICE"
CURRENT_IMAGE="$(g run services describe "$API_SERVICE" --region="$REGION" \
  --format='value(spec.template.spec.containers[0].image)' 2>/dev/null || true)"
CORE_VERSION="$(g run services describe "$API_SERVICE" --region="$REGION" --format=json 2>/dev/null |
  bun -e 'const s=JSON.parse(await Bun.stdin.text()||"{}");const e=s?.spec?.template?.spec?.containers?.[0]?.env??[];console.log(e.find(v=>v.name==="CORE_VERSION")?.value??"")' || true)"
IMAGE="${IMAGE:-$CURRENT_IMAGE}"
if [[ -z "$IMAGE" ]]; then
  TAG="$("$DEPLOY_DIR/build.sh")"
  IMAGE="$REGION-docker.pkg.dev/$PROJECT/$AR_REPO/core-api:$TAG"
  CORE_VERSION="$TAG"
fi
ENV_VARS="ELECTRIC_URL=$ELECTRIC_URL|LLM_UPSTREAM_AUTH=google|GCP_PROJECT=$PROJECT"
ENV_VARS+="|LLM_DEFAULT_MODEL=google/gemini-3.8-flash|LLM_UPSTREAM_STRIP_PREFIX=/v1"
ENV_VARS+="|LLM_SMALL_MODEL=google/gemini-3.5-flash-lite"
ENV_VARS+="|VOICE_MODEL=gemini-3.8-live|VOICE_LOCATION=us-central1"
ENV_VARS+="|CORE_CORS_ORIGINS=$CORE_CORS_ORIGINS|BILLING_SUCCESS_URL=$BILLING_SUCCESS_URL"
ENV_VARS+="|BILLING_CANCEL_URL=$BILLING_CANCEL_URL|MAIL_PROVIDER=resend|MAIL_FROM=$MAIL_FROM"
ENV_VARS+="|PUBLIC_SITE_URL=$PUBLIC_SITE_URL|ORBIT_DOWNLOAD_URL=$ORBIT_DOWNLOAD_URL"
ENV_VARS+="|ORDERS_EMAIL=$ORDERS_EMAIL|STRIPE_AUTOMATIC_TAX=$STRIPE_AUTOMATIC_TAX"
ENV_VARS+="|CORE_FEEDBACK_EMAIL=$CORE_FEEDBACK_EMAIL"
ENV_VARS+="|TERMS_VERSION=$TERMS_VERSION|CORE_VERSION=${CORE_VERSION:-unknown}"
ENV_VARS+="|ELEVENLABS_AGENT_ID=$ELEVENLABS_AGENT_ID|ELEVENLABS_VOICE_MALE=$ELEVENLABS_VOICE_MALE"
ENV_VARS+="|VOICE_AGENT_ID=$VOICE_AGENT_ID"
SECRETS=""
for name in DATABASE_URL ELECTRIC_SECRET STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET MAIL_API_KEY; do
  SECRETS+="${SECRETS:+,}$name=$(secret_id "$name"):latest"
done
if quiet g secrets describe ELEVENLABS_API_KEY; then
  SECRETS+=",ELEVENLABS_API_KEY=ELEVENLABS_API_KEY:latest"
fi
if [[ -n "${SECRET_CORE_ADMIN_TOKEN:-}" ]]; then
  secret_set CORE_ADMIN_TOKEN "$SECRET_CORE_ADMIN_TOKEN"
fi
if secret_has_real_value CORE_ADMIN_TOKEN; then
  SECRETS+=",CORE_ADMIN_TOKEN=$(secret_id CORE_ADMIN_TOKEN):latest"
fi
g run deploy "$API_SERVICE" --region="$REGION" --image="$IMAGE" \
  --service-account="$RUNTIME_SA" --allow-unauthenticated --port=8080 \
  --add-cloudsql-instances="$SQL_CONN" \
  --network="$NETWORK" --subnet="$NETWORK" --vpc-egress=private-ranges-only \
  --set-env-vars="^|^$ENV_VARS" --set-secrets="$SECRETS" \
  --cpu=1 --memory=512Mi --concurrency=80 --timeout=3600 --cpu-boost \
  --min-instances="$API_MIN" --max-instances="$API_MAX" \
  --execution-environment=gen2 --labels="$LABELS" >/dev/null
API_URL="$(g run services describe "$API_SERVICE" --region="$REGION" --format='value(status.url)')"

log "smoke $SMOKE_PATH"
curl -fsS --retry 5 --retry-delay 3 --retry-all-errors "$API_URL$SMOKE_PATH"
echo
cat <<EOF
Environment:        $ENV
API:                $API_URL
Electric (internal): $ELECTRIC_URL
Cloud SQL:          $SQL_CONN ($SQL_TIER)
GitHub variables:   GCP_PROJECT=$PROJECT GCP_REGION=$REGION
                    GCP_WIF_PROVIDER=projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$WIF_POOL/providers/$WIF_PROVIDER
                    GCP_DEPLOY_SA=$DEPLOYER_SA
EOF
