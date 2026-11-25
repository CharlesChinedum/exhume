#!/usr/bin/env bash
# Container entrypoint used by run-risks.sh. /opt/forge-std is baked into the image.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE=docker
FORGE_STD_DIR=/opt/forge-std
# shellcheck source=lib.sh
. "$HERE/lib.sh"

check_forge_version
PIN="$(tr -d '[:space:]' <"$HERE/FORGE_STD_PIN")"
IMAGE_SHA="$(git -C "$FORGE_STD_DIR" rev-parse HEAD)"
PIN_SHA="$(git -C "$FORGE_STD_DIR" rev-parse "$PIN^{commit}")"
if [ "$IMAGE_SHA" != "$PIN_SHA" ]; then
  echo "/opt/forge-std ($IMAGE_SHA) does not match FORGE_STD_PIN $PIN ($PIN_SHA)" >&2
  exit 1
fi
echo "forge-std $PIN ($IMAGE_SHA) at $FORGE_STD_DIR"
export FORGE_STD_DIR MODE HERE
run_all
