#!/usr/bin/env bash
# Build core/api/Dockerfile on Cloud Build (never on the dev machine) from the current working
# tree and push it to Artifact Registry. Prints the image tag on stdout.
#   core/deploy/build.sh            # tag = <git sha>[-dirty-<timestamp>]
set -euo pipefail

PROJECT="${PROJECT:-agrointel-dd8f6}"
REGION="${REGION:-europe-north1}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TAG="${TAG:-$(git rev-parse --short=12 HEAD)}"
if [[ -z "${TAG_FIXED:-}" ]] && [[ -n "$(git status --porcelain -- core packages/schema package.json bun.lock)" ]]; then
  TAG="$TAG-dirty-$(date -u +%Y%m%d%H%M%S)"
fi
IMAGE="$REGION-docker.pkg.dev/$PROJECT/orbit-core/core-api:$TAG"

echo "WORKING: core-deploy - Cloud Build $IMAGE" >&2
gcloud --project "$PROJECT" --quiet builds submit "$ROOT" \
  --config=core/deploy/cloudbuild.yaml --ignore-file=core/deploy/gcloudignore \
  --substitutions="_IMAGE=$IMAGE" >&2
echo "$TAG"
