#!/usr/bin/env bash
# Task 1.11, Risk 9 (native only): seed determinism of discovery (Part 1) and of a rare witness (Part 2).
# Every run uses a FRESH scratch directory (fresh copy of fixtures/token, no cache/ or out/ reuse).
# Exit code reflects Part 1 only (PASS = 5 identical hashes and class counts). Part 2 variation is a finding.
# harness: native-only
set -uo pipefail

RUNS=256
DEPTH=64
SEED=42
N=5
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RISK_DIR="$HERE/risks"
: "${MODE:=native}"
: "${FORGE_STD_DIR:=$HERE/.cache/forge-std}"
: "${FINDINGS_FILE:=$HERE/findings/1.11.native.md}"
[ "$MODE" = native ] || { echo "1.11 is native only" >&2; exit 2; }
FORGE_STD_DIR="$(cd "$FORGE_STD_DIR" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

write_toml() { # $1 = discovery|witness
  local extra=""
  [ "$1" = discovery ] && extra="shrink_run_limit = 0"
  cat >foundry.toml <<EOF
[profile.default]
src = "src"
out = "out"
allow_paths = ["$FORGE_STD_DIR"]
fs_permissions = [{ access = "read", path = "./out" }, { access = "read-write", path = "./seance-out" }]
optimizer = false
optimizer_runs = 1
gas_limit = 1000000000
additional_compiler_profiles = [{ name = "legacy_opt", optimizer = true, optimizer_runs = 200 }]
compilation_restrictions = [
  { paths = "src/legacy/LegacyToken.sol", version = "=0.4.19" },
  { paths = "src/port/PortToken.sol", version = "=0.8.28" },
  { paths = "$FORGE_STD_DIR/src/**", version = "=0.8.28" },
  { paths = "test/**", version = "=0.8.28" },
]

[profile.default.invariant]
runs = $RUNS
depth = $DEPTH
fail_on_revert = true
$extra
EOF
}

# fresh_dir <name> <kind> <testfile-source>: creates $WORK/<name>, copies the fixture, cd's into it (caller uses a subshell).
fresh_dir() {
  local d="$WORK/$1"
  rm -rf "$d"; mkdir -p "$d"
  cp -R "$HERE/fixtures/token/." "$d/"
  rm -rf "$d/out" "$d/cache"
  mkdir -p "$d/test" "$d/seance-out"
  cp "$3" "$d/test/"
  printf 'forge-std/=%s/src/\n' "$FORGE_STD_DIR" >"$d/remappings.txt"
  echo "$d"
}

# ---------- Part 1 helper: one discovery run. Args: name, seed-mode (flag|env|none). Prints result line to res/<name>.
discovery_run() {
  local name="$1" smode="$2" d
  d="$(fresh_dir "$name" discovery "$RISK_DIR/1.8-wallclock/Bench.t.sol")"
  (
    cd "$d" || exit 1
    write_toml discovery
    forge build --offline >build.log 2>&1 || { echo "BUILD-FAILED" >"$WORK/res.$name"; exit 0; }
    local rc
    case "$smode" in
      flag) SEANCE_RECORD=1 forge test --offline --match-contract SeanceBench --match-test invariant_discovery --fuzz-seed "$SEED" -vv >campaign.log 2>&1; rc=$? ;;
      env)  SEANCE_RECORD=1 FOUNDRY_FUZZ_SEED="$SEED" forge test --offline --match-contract SeanceBench --match-test invariant_discovery -vv >campaign.log 2>&1; rc=$? ;;
      invenv) SEANCE_RECORD=1 FOUNDRY_INVARIANT_SEED="$SEED" forge test --offline --match-contract SeanceBench --match-test invariant_discovery -vv >campaign.log 2>&1; rc=$? ;;
      none) SEANCE_RECORD=1 forge test --offline --match-contract SeanceBench --match-test invariant_discovery -vv >campaign.log 2>&1; rc=$? ;;
    esac
    local rec=seance-out/records.jsonl full="NOFILE" first="NOFILE" lines=-1
    if [ -f "$rec" ]; then
      full=$(sha "$rec"); lines=$(wc -l <"$rec" | tr -d ' ')
      head -n $((RUNS * DEPTH)) "$rec" >first.jsonl; first=$(sha first.jsonl)
    fi
    cnt() { [ -f "$rec" ] && { grep -c "\"class\":\"$1\"" "$rec" || true; } || echo -1; }
    local line calls
    line="$(grep -E '\[(PASS|FAIL[^]]*)\] invariant_discovery' campaign.log | head -1)"
    calls=$(sed -nE 's/.*calls: ([0-9]+).*/\1/p' <<<"$line" | head -1)
    echo "$full $first $lines $(cnt match) $(cnt reason-modernised) $(cnt exorcised) $(cnt port-bug) ${calls:--1} $rc" >"$WORK/res.$name"
    cp campaign.log "$WORK/log.$name" 2>/dev/null
  )
}

# ---------- seed plumbing probe (config level)
probe_cfg() {
  local d; d="$(fresh_dir probe cfg "$RISK_DIR/1.8-wallclock/Bench.t.sol")"
  ( cd "$d" && write_toml discovery
    echo "inv_keys=$(forge config --json 2>/dev/null | jq -c '.invariant | keys')"
    echo "cfg_default_fuzz_seed=$(forge config --json 2>/dev/null | jq -c '.fuzz.seed')"
    echo "cfg_env_fuzz_seed=$(FOUNDRY_FUZZ_SEED=42 forge config --json 2>/dev/null | jq -c '.fuzz.seed')"
    echo "cfg_env_invariant_seed=$(FOUNDRY_INVARIANT_SEED=42 forge config --json 2>/dev/null | jq -c '[.fuzz.seed, .invariant.seed]')"
    cp foundry.toml foundry.toml.orig
    echo 'seed = "0x2a"' >>foundry.toml   # appended to the [profile.default.invariant] table
    echo "cfg_toml_invariant_seed: forge config exit=$(forge config --json >cfg.out 2>cfg.err; echo $?); invariant.seed=$(jq -c '.invariant.seed' cfg.out 2>/dev/null); fuzz.seed=$(jq -c '.fuzz.seed' cfg.out 2>/dev/null); stderr=$(head -c 200 cfg.err | tr '\n' ' ')"
    mv foundry.toml.orig foundry.toml
  )
}
PROBE_CFG="$(probe_cfg)"

# ---------- Part 1
for i in $(seq 1 $N); do discovery_run "d$i" flag; done
# Seed-mechanism comparison (2 fresh runs each): env var FOUNDRY_FUZZ_SEED, FOUNDRY_INVARIANT_SEED, and no seed.
for m in env invenv none; do for i in 1 2; do discovery_run "m.$m.$i" "$m"; done; done

p1_ok=yes
ref="$(cat "$WORK/res.d1")"
set -- $ref; ref_hash="$1 $2"; ref_counts="$4 $5 $6 $7"
for i in $(seq 1 $N); do
  set -- $(cat "$WORK/res.d$i")
  [ "$1 $2" = "$ref_hash" ] && [ "$4 $5 $6 $7" = "$ref_counts" ] || p1_ok=no
done

# ---------- Part 2: rare witness at ~1e-4 per call, default shrink limit, --fuzz-seed 42, 5 fresh dirs.
witness_run() { # name scenario
  local name="$1" scen="$2" d
  d="$(fresh_dir "$name" witness "$RISK_DIR/1.11-seed-determinism/Witness.t.sol")"
  (
    cd "$d" || exit 1
    write_toml witness
    forge build --offline >build.log 2>&1 || { echo "BUILD-FAILED - - -" >"$WORK/res.$name"; exit 0; }
    SEANCE_RECORD=0 SEANCE_WITNESS="$scen" forge test --offline --match-contract SeanceWitness --match-test invariant_witness \
      --fuzz-seed "$SEED" --json >out.json 2>err.log
    local rc=$? st fr sl
    st=$(jq -r '[.[]|.test_results["invariant_witness()"]][0].status // "none"' out.json 2>/dev/null || echo none)
    fr=$(jq -r '[.[]|.test_results["invariant_witness()"]][0].kind.Invariant.runs // -1' out.json 2>/dev/null || echo -1)
    sl=$(jq -r '[.[]|.test_results["invariant_witness()"]][0].counterexample.Sequence[1] | if type=="array" then length else -1 end' out.json 2>/dev/null || echo -1)
    echo "$st $fr $sl $rc" >"$WORK/res.$name"
  )
}
for i in $(seq 1 $N); do witness_run "w$i" rare1e4; done
# Context: the same five runs for the shipped 6e-4 'rare' condition.
for i in $(seq 1 $N); do witness_run "v$i" rare; done

# Fraction of the ~1e-4 estimate: measured how often 'hit' is reached cannot be read from forge; the estimate is analytic:
#   P(actor=0xA3)=1/4, P(cnt=7)=1/22, P(exorcised | targeted)>0.5 ..., P(rcv[0]=0)=1/5, P(rcv[1]=0)=1/5, P(batchTransfer)=1/2.

verdict=PASS; [ "$p1_ok" = yes ] || verdict="FAIL (discovery not seed-deterministic)"

{
  echo "# 1.11 Risk 9: seed determinism of discovery and of a rare witness (native)"
  echo
  echo "**$verdict**  (exit code reflects Part 1 only; Part 2 variation is a finding, not a failure)"
  echo
  echo "- Mode: **native** only. forge: $(forge --version | head -1)"
  echo "- Config: runs=$RUNS, depth=$DEPTH, fail_on_revert=true, \`--fuzz-seed $SEED\`, foundry.toml as in 1.8 (discovery, shrink_run_limit=0) and 1.9 (witness, default shrink_run_limit, SEANCE_RECORD=0). Every run in its own fresh directory (fresh copy of fixtures/token, no cache/ or out/ reuse, forge build repeated each time)."
  echo
  echo "## Part 1: discovery (1.8 Bench.t.sol, recording on, \`--fuzz-seed $SEED\`)"
  echo
  echo "Class is read from the \`\"class\"\` field of each record line (the 1.8 handler writes it). \`first\` = sha256 of the first runs*depth = $((RUNS*DEPTH)) lines (replay tail of $DEPTH lines removed, design decision 13)."
  echo
  echo "| run | sha256 (full file) | sha256 (first $((RUNS*DEPTH)) lines) | lines | match | reason-modernised | exorcised | port-bug | forge calls | exit |"
  echo "|---|---|---|---|---|---|---|---|---|---|"
  for i in $(seq 1 $N); do
    set -- $(cat "$WORK/res.d$i")
    echo "| $i | \`$1\` | \`$2\` | $3 | $4 | $5 | $6 | $7 | $8 | $9 |"
  done
  echo
  echo "- Part 1 identical across all 5 (hashes and class counts): **$p1_ok**."
  [ "$p1_ok" = yes ] || echo "- Finding: **discovery not seed-deterministic**."
  echo
  echo "### Seed mechanisms (invariant campaign, discovery fixture, 2 fresh runs each)"
  echo
  echo "| mechanism | run | sha256 (full) | sha256 (first $((RUNS*DEPTH))) | lines | match | reason-modernised | exorcised | port-bug | calls | exit |"
  echo "|---|---|---|---|---|---|---|---|---|---|---|"
  set -- $(cat "$WORK/res.d1")
  echo "| \`--fuzz-seed $SEED\` (run 1 above) | 1 | \`$1\` | \`$2\` | $3 | $4 | $5 | $6 | $7 | $8 | $9 |"
  for m in env invenv none; do
    label="FOUNDRY_FUZZ_SEED=$SEED"; [ "$m" = invenv ] && label="FOUNDRY_INVARIANT_SEED=$SEED"; [ "$m" = none ] && label="no seed"
    for i in 1 2; do
      set -- $(cat "$WORK/res.m.$m.$i")
      echo "| $label | $i | \`$1\` | \`$2\` | $3 | $4 | $5 | $6 | $7 | $8 | $9 |"
    done
  done
  echo
  echo "Config-level probe (\`forge config --json\`):"
  echo
  echo '```'
  echo "$PROBE_CFG"
  echo '```'
  echo
  echo "## Part 2: rare witness (exorcised batchTransfer, actor 0xA3, 7 receivers, rcv[0] == 0 and rcv[1] == 0; about 1e-4 per call; \`--fuzz-seed $SEED\`)"
  echo
  echo "The 1.9 fixture only contains the 6e-4 variant (rcv[0] == 0). The 1e-4 variant (one more receiver constraint, rcv[1] == address(0)) was recreated as mode \`rare1e4\` in \`risks/1.11-seed-determinism/Witness.t.sol\` (a copy of the 1.9 fixture plus that mode). Default shrink_run_limit, SEANCE_RECORD=0."
  echo
  echo "| run | status | run at which invariant failed (forge \`runs\`) | shrunk sequence length | exit |"
  echo "|---|---|---|---|---|"
  for i in $(seq 1 $N); do
    set -- $(cat "$WORK/res.w$i")
    if [ "$1" = Success ]; then echo "| $i | passed | passed (all $RUNS runs) | n/a | $4 |"
    else echo "| $i | $1 | $2 | $3 | $4 |"; fi
  done
  echo
  echo "### Same five runs for the shipped 6e-4 condition from 1.9 (context)"
  echo
  echo "| run | status | run at which invariant failed | shrunk sequence length | exit |"
  echo "|---|---|---|---|---|"
  for i in $(seq 1 $N); do
    set -- $(cat "$WORK/res.v$i")
    if [ "$1" = Success ]; then echo "| $i | passed | passed (all $RUNS runs) | n/a | $4 |"
    else echo "| $i | $1 | $2 | $3 | $4 |"; fi
  done
  w_vals="$(for i in $(seq 1 $N); do set -- $(cat "$WORK/res.w$i"); echo "$1:$2"; done | sort -u | wc -l | tr -d ' ')"
  echo
  echo "- Part 2 distinct outcomes among the 5 runs: **$w_vals**."
} >"$FINDINGS_FILE"

cat "$FINDINGS_FILE"
[ "$p1_ok" = yes ]
