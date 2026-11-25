#!/usr/bin/env bash
# Runs every risk script (risks/*.sh) natively, each in a scratch copy of
# fixtures/token, against a local forge-std checkout at the FORGE_STD_PIN version.
# Override the checkout location with FORGE_STD_DIR.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE=native
# shellcheck source=lib.sh
. "$HERE/lib.sh"

check_forge_version

PIN="$(tr -d '[:space:]' <"$HERE/FORGE_STD_PIN")"
FORGE_STD_DIR="${FORGE_STD_DIR:-$HERE/.cache/forge-std}"

if [ ! -d "$FORGE_STD_DIR/.git" ]; then
  mkdir -p "$(dirname "$FORGE_STD_DIR")"
  git clone --quiet https://github.com/foundry-rs/forge-std "$FORGE_STD_DIR"
fi
if [ "$(git -C "$FORGE_STD_DIR" rev-parse HEAD)" != "$(git -C "$FORGE_STD_DIR" rev-parse "$PIN^{commit}" 2>/dev/null || true)" ]; then
  git -C "$FORGE_STD_DIR" fetch --quiet --tags origin
  git -C "$FORGE_STD_DIR" -c advice.detachedHead=false checkout --quiet "$PIN"
fi
FORGE_STD_DIR="$(cd "$FORGE_STD_DIR" && pwd)"
HEAD_SHA="$(git -C "$FORGE_STD_DIR" rev-parse HEAD)"

echo "forge-std $PIN ($HEAD_SHA) at $FORGE_STD_DIR"
mkdir -p "$HERE/findings"
printf 'forge-std path: %s\nforge-std pin: %s\nforge-std commit: %s\n' \
  "$FORGE_STD_DIR" "$PIN" "$HEAD_SHA" >"$HERE/findings/native-env.txt"

export FORGE_STD_DIR MODE HERE
run_all
