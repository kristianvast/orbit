#!/usr/bin/env bash
# Windows has no bash or git. Fetch MinGit (checksum-pinned) into the folder the Windows installer bundles,
# so Orion can run shell commands and use git on a farmer's PC without installing anything.
set -euo pipefail

cd "$(dirname "$0")/.."
MINGIT_TAG="v2.56.1.windows.1"
MINGIT_ZIP="MinGit-2.56.1-64-bit.zip"
MINGIT_SHA256="4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd"
MINGIT_DIR="apps/orbit/src-tauri/resources/mingit"

[ -f "$MINGIT_DIR/usr/bin/sh.exe" ] && exit 0
echo "==> MinGit $MINGIT_TAG"
TMP="$(mktemp -d)"
curl --fail --location --retry 3 \
  "https://github.com/git-for-windows/git/releases/download/$MINGIT_TAG/$MINGIT_ZIP" \
  --output "$TMP/$MINGIT_ZIP"
echo "$MINGIT_SHA256  $TMP/$MINGIT_ZIP" | sha256sum --check --status \
  || { echo "MinGit checksum mismatch" >&2; exit 1; }
mkdir -p "$MINGIT_DIR"
unzip -q -o "$TMP/$MINGIT_ZIP" -d "$MINGIT_DIR"
rm -rf "$TMP"
