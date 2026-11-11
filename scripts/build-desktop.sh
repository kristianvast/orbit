#!/usr/bin/env bash
# Build the Orbit desktop app for this machine: Orion sidecar, go2rtc, then Tauri.
# Usage: scripts/build-desktop.sh [--release]   (default: debug build, unsigned)
set -euo pipefail

cd "$(dirname "$0")/.."
PROFILE="${1:---debug}"
GO2RTC_VERSION="v1.9.15"

TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
case "$TRIPLE" in
  x86_64-pc-windows-msvc)    BUN_TARGET=bun-windows-x64;  GO2RTC=go2rtc_win64.zip;       EXE=.exe ;;
  x86_64-unknown-linux-gnu)  BUN_TARGET=bun-linux-x64;    GO2RTC=go2rtc_linux_amd64;     EXE="" ;;
  aarch64-unknown-linux-gnu) BUN_TARGET=bun-linux-arm64;  GO2RTC=go2rtc_linux_arm64;     EXE="" ;;
  aarch64-apple-darwin)      BUN_TARGET=bun-darwin-arm64; GO2RTC=go2rtc_mac_arm64.zip;   EXE="" ;;
  x86_64-apple-darwin)       BUN_TARGET=bun-darwin-x64;   GO2RTC=go2rtc_mac_amd64.zip;   EXE="" ;;
  *) echo "Unsupported host: $TRIPLE" >&2; exit 1 ;;
esac

BIN_DIR="apps/orbit/src-tauri/binaries"
mkdir -p "$BIN_DIR"

echo "==> Orion sidecar ($BUN_TARGET)"
bun build --compile --minify --keep-names --target="$BUN_TARGET" packages/orion/src/main.ts \
  --outfile "$BIN_DIR/orion-$TRIPLE$EXE"

GO2RTC_DEST="$BIN_DIR/go2rtc-$TRIPLE$EXE"
if [ ! -x "$GO2RTC_DEST" ]; then
  echo "==> go2rtc $GO2RTC_VERSION ($GO2RTC)"
  TMP="$(mktemp -d)"
  curl --fail --location --retry 3 \
    "https://github.com/AlexxIT/go2rtc/releases/download/$GO2RTC_VERSION/$GO2RTC" \
    --output "$TMP/$GO2RTC"
  if [[ "$GO2RTC" == *.zip ]]; then
    unzip -q "$TMP/$GO2RTC" -d "$TMP/unpacked"
    cp "$TMP/unpacked/go2rtc$EXE" "$GO2RTC_DEST"
  else
    cp "$TMP/$GO2RTC" "$GO2RTC_DEST"
  fi
  chmod +x "$GO2RTC_DEST"
  rm -rf "$TMP"
fi

# Windows has no bash or git; ship MinGit next to the sidecars.
if [ "$TRIPLE" = "x86_64-pc-windows-msvc" ]; then
  scripts/fetch-mingit.sh
fi

echo "==> Tauri build ($PROFILE)"
cd apps/orbit
# CI=true makes the macOS DMG step skip its Finder AppleScript, which otherwise asks for Automation access.
export CI="${CI:-true}"
if [ "$PROFILE" = "--release" ]; then
  bunx tauri build
else
  bunx tauri build --debug
fi
