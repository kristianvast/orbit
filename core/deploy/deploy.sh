#!/usr/bin/env bash
# Build the current working tree on Cloud Build and roll it out to an already provisioned
# environment (run provision.sh first). Configuration and secrets are owned by provision.sh;
# this only changes the image and CORE_VERSION.
#   ENV=staging core/deploy/deploy.sh
set -euo pipefail

ENV="${ENV:?set ENV=staging|production}"
PROJECT="${PROJECT:-agrointel-dd8f6}"
REGION="${REGION:-europe-north1}"
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE="orbit-core-$ENV"
# Cloud Run's Google front end reserves some paths ending in "z" (/healthz never reaches the
# container on run.app), so smoke-test the /health alias (same handler: liveness + select 1).
SMOKE_PATH="${SMOKE_PATH:-/health}"

TAG="$("$DEPLOY_DIR/build.sh")"
IMAGE="$REGION-docker.pkg.dev/$PROJECT/orbit-core/core-api:$TAG"
echo "WORKING: core-deploy - deploy $SERVICE" >&2
gcloud --project "$PROJECT" --quiet run deploy "$SERVICE" --region="$REGION" \
  --image="$IMAGE" --update-env-vars="CORE_VERSION=$TAG" >&2
URL="$(gcloud --project "$PROJECT" run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')"
curl -fsS --retry 5 --retry-delay 3 --retry-all-errors "$URL$SMOKE_PATH"
echo
echo "$SERVICE $TAG $URL" >&2
