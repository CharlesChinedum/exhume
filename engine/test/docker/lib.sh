#!/usr/bin/env bash
# Shared by run-risks-native.sh and run-risks.sh (and the container entrypoint).
# Expects: MODE (native|docker), FORGE_STD_DIR, HERE (this directory).

EXPECTED_FORGE=1.5.1

check_forge_version() {
  local out
  out="$(forge --version 2>&1)" || { echo "forge not runnable: $out" >&2; return 1; }
  if ! grep -Eq "^forge Version: ${EXPECTED_FORGE//./\\.}(-|$)" <<<"$out"; then
    echo "forge --version does not report ${EXPECTED_FORGE}:" >&2
    echo "$out" >&2
    return 1
  fi
  echo "forge ${EXPECTED_FORGE} OK"
}

# Copy the fixture project into a scratch dir and wire up forge-std.
make_scratch() {
  local dest="$1"
  cp -R "$HERE/fixtures/token/." "$dest/"
  rm -rf "$dest/out" "$dest/cache"
  printf 'forge-std/=%s/src/\n' "$FORGE_STD_DIR" >"$dest/remappings.txt"
  # allow_paths is a [profile.default] key; the fixture's table is the only one.
  printf 'allow_paths = ["%s"]\n' "$FORGE_STD_DIR" >>"$dest/foundry.toml"
}

run_all() {
  mkdir -p "$HERE/findings"
  shopt -s nullglob
  local scripts=("$HERE"/risks/*.sh)
  if [ ${#scripts[@]} -eq 0 ]; then
    echo "NOTICE: no risk scripts found in $HERE/risks/ (tasks 1.2 to 1.9 add them); nothing to run."
    return 0
  fi
  local failed=0 s name scratch
  for s in "${scripts[@]}"; do
    name="$(basename "$s" .sh)"
    scratch="$(mktemp -d)"
    make_scratch "$scratch"
    echo "== [$MODE] $name (scratch: $scratch)"
    if (cd "$scratch" && \
        MODE="$MODE" RISK_NAME="$name" SCRATCH="$scratch" FIXTURE_DIR="$scratch" \
        FORGE_STD_DIR="$FORGE_STD_DIR" \
        FINDINGS_FILE="$HERE/findings/$name.$MODE.md" \
        bash "$s"); then
      echo "== [$MODE] $name: exit 0"
    else
      echo "== [$MODE] $name: FAILED" >&2
      failed=$((failed + 1))
    fi
    rm -rf "$scratch"
  done
  [ "$failed" -eq 0 ]
}
