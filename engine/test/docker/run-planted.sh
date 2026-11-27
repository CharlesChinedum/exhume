#!/usr/bin/env bash
# Task 15.2: runs the planted-bug real-forge test inside the exhume-seance image (linux/amd64).
# Usage: engine/test/docker/run-planted.sh   (build first: see Dockerfile.seance header)
# graveyard/ is mounted READ-ONLY at /app/graveyard, where the test expects it, so nothing can write to graveyard/bec.
# The CLI entrypoint is overridden only for this run; the image default is unchanged.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
exec docker run --rm --platform linux/amd64 \
  -v "$ROOT/graveyard:/app/graveyard:ro" \
  -e SEANCE_DOCKER=1 \
  --entrypoint pnpm \
  "${SEANCE_IMAGE:-exhume-seance}" \
  exec vitest run test/seance/planted-bug.docker.test.ts
