#!/usr/bin/env bash
# Register the Stripe webhook for one environment (once) and store its signing secret in
# Secret Manager, then roll a new API revision so the secret is picked up. Uses the Stripe key
# already stored in orbit-core-<env>-STRIPE_SECRET_KEY; nothing secret is printed.
# Also creates missing products/prices with core/api/src/stripe-setup.ts.
#   ENV=staging core/deploy/stripe-webhook.sh
set -euo pipefail

ENV="${ENV:?set ENV=staging|production}"
PROJECT="${PROJECT:-agrointel-dd8f6}"
REGION="${REGION:-europe-north1}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE="orbit-core-$ENV"
EVENTS=(checkout.session.completed checkout.session.async_payment_succeeded
  checkout.session.async_payment_failed customer.subscription.created
  customer.subscription.updated customer.subscription.deleted invoice.payment_failed)
LOOKUP_KEYS=(pecorva_pen_monthly pecorva_pen_yearly pecorva_barn_monthly pecorva_barn_yearly
  pecorva_box pecorva_camera)

g() { gcloud --project "$PROJECT" --quiet "$@"; }
secret() { g secrets versions access latest --secret "orbit-core-$ENV-$1"; }

STRIPE_API_KEY="$(secret STRIPE_SECRET_KEY)"
export STRIPE_API_KEY
[[ "$STRIPE_API_KEY" == sk_* ]] || {
  echo "orbit-core-$ENV-STRIPE_SECRET_KEY is not a Stripe secret key" >&2
  exit 1
}
URL="$(g run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')/v1/billing/webhook"

endpoint_id="$(stripe webhook_endpoints list --limit 100 |
  bun -e 'const j=await Bun.stdin.json();console.log(j.data.find(e=>e.url===process.argv[1])?.id??"")' "$URL")"
event_args=()
for e in "${EVENTS[@]}"; do event_args+=(--enabled-events "$e"); done

if [[ -n "$endpoint_id" ]]; then
  stripe webhook_endpoints update "$endpoint_id" "${event_args[@]}" >/dev/null
  echo "webhook $endpoint_id exists for $URL (events updated)" >&2
  if [[ "$(secret STRIPE_WEBHOOK_SECRET)" != whsec_* ]]; then
    echo "but orbit-core-$ENV-STRIPE_WEBHOOK_SECRET is unset: roll the endpoint secret in the" \
      "Stripe dashboard and store it with gcloud secrets versions add --data-file=-" >&2
    exit 1
  fi
else
  stripe webhook_endpoints create --url "$URL" --description "Orbit Core $ENV" "${event_args[@]}" |
    bun -e 'const j=await Bun.stdin.json();if(!j.secret?.startsWith("whsec_"))throw new Error(JSON.stringify(j.error??"no secret"));process.stdout.write(j.secret)' |
    g secrets versions add "orbit-core-$ENV-STRIPE_WEBHOOK_SECRET" --data-file=- >/dev/null
  echo "webhook created for $URL; signing secret stored" >&2
  g run services update "$SERVICE" --region="$REGION" \
    --update-labels="secrets-rollout=$(date -u +%Y%m%d%H%M%S)" >/dev/null
  echo "rolled $SERVICE to pick up the new secret" >&2
fi

price_args=()
for k in "${LOOKUP_KEYS[@]}"; do price_args+=(-d "lookup_keys[]=$k"); done
found="$(stripe prices list --active true --limit 100 "${price_args[@]}" |
  bun -e 'const j=await Bun.stdin.json();console.log(new Set(j.data.map(p=>p.lookup_key)).size)')"
if [[ "$found" -lt "${#LOOKUP_KEYS[@]}" ]]; then
  echo "prices: $found/${#LOOKUP_KEYS[@]} present, running stripe-setup" >&2
  STRIPE_SECRET_KEY="$STRIPE_API_KEY" bun "$ROOT/core/api/src/stripe-setup.ts" >&2
else
  echo "prices: all ${#LOOKUP_KEYS[@]} present" >&2
fi
