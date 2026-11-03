#!/usr/bin/env bash
# Serialises bun install across parallel agents: mkdir is atomic on every OS.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="$ROOT/.handoff/.install.lock"
mkdir -p "$ROOT/.handoff"
for i in $(seq 1 600); do
  if mkdir "$LOCK" 2>/dev/null; then
    trap 'rmdir "$LOCK"' EXIT
    cd "$ROOT"
    if [ "$#" -gt 0 ]; then (cd "$1" && shift && bun add "$@"); else bun install; fi
    exit 0
  fi
  sleep 1
done
echo "locked-install: timed out waiting for $LOCK" >&2; exit 1
