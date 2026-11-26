#!/usr/bin/env bash
# Builds the linux/amd64 image and runs every risk script (risks/*.sh) inside it,
# each in a scratch copy of fixtures/token.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${IMAGE:-exhume-seance-risks:local}"
PIN="$(tr -d '[:space:]' <"$HERE/FORGE_STD_PIN")"

docker build --platform linux/amd64 \
  --build-arg "FORGE_STD_PIN=$PIN" \
  -t "$IMAGE" -f "$HERE/Dockerfile" "$HERE"

# Mount the harness directory so findings/*.docker.md land in the repo.
docker run --rm --platform linux/amd64 \
  -v "$HERE:/work" -v "$HERE/../fixtures:/fixtures:ro" -w /work \
  "$IMAGE" bash /work/run-in-container.sh
