#!/usr/bin/env bash
# Task 1.9, Risk 8: wall-clock time of an invariant_witness campaign with recording off (SEANCE_RECORD=0),
# default shrinking, runs=256, depth=64. Runs in a scratch copy of fixtures/token. Exits non-zero on FAIL.
# Runs unchanged in Docker; the mode label comes from $MODE. Docker timing on Apple Silicon is emulated and
# is not used for the PASS decision; the PASS decision applies to MODE=native only.
set -uo pipefail

RUNS=256
DEPTH=64
DEADLINE_S=300
SEED=42
UNSET_REPEATS=3
REPLAY_REPEATS=3
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/1.9-witness-time"
FINDINGS_DIR_DEFAULT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/findings"
: "${FINDINGS_FILE:?}" "${MODE:?}" "${FORGE_STD_DIR:?}"
FINDINGS_DIR="$(dirname "$FINDINGS_FILE")"
DISCOVERY_FILE="${DISCOVERY_FINDINGS:-$FINDINGS_DIR/1.8.$MODE.md}"

now() { perl -MTime::HiRes=time -e 'printf "%.3f\n", time'; }
elapsed() { perl -e 'printf "%.2f", $ARGV[1] - $ARGV[0]' "$1" "$2"; }

# Same foundry.toml as 1.8 (1.5 and 1.7 schemes), except shrink_run_limit is NOT set: forge's default applies.
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
EOF
printf 'forge-std/=%s/src/\n' "$FORGE_STD_DIR" >remappings.txt
mkdir -p test seance-out
cp "$SRC_DIR/Witness.t.sol" test/Witness.t.sol
rm -rf out cache

default_shrink=$(forge config --json 2>/dev/null | jq -r '.invariant.shrink_run_limit // "unknown"')
shrink_env_check=$(FOUNDRY_INVARIANT_SHRINK_RUN_LIMIT=0 forge config --json 2>/dev/null | jq -r '.invariant.shrink_run_limit // "unknown"')

t0=$(now); forge build --offline >build.cold.log 2>&1; build_rc=$?; t1=$(now)
build_secs=$(elapsed "$t0" "$t1")

# discovery time measured by task 1.8 (same mode), first numeric column of the "ON" row.
discovery_secs=$(sed -nE 's/^\| ON [^|]*\| ([0-9.]+) \|.*/\1/p' "$DISCOVERY_FILE" 2>/dev/null | head -1)
discovery_note="read from $(basename "$DISCOVERY_FILE")"
if [ -z "$discovery_secs" ]; then discovery_secs=0; discovery_note="NOT FOUND in $DISCOVERY_FILE (treated as 0)"; fi

# One witness campaign. Args: name scenario seedmode(fixed|unset) shrink(default|0).
# Echoes: secs rc status seqlen runs (runs = the run index forge reports for the failing run, or all runs). Keeps <name>.out.json and <name>.err.log.
campaign() {
  local name="$1" scen="$2" seedmode="$3" shrink="$4" t0 t1 rc secs
  local seedargs=()
  [ "$seedmode" = fixed ] && seedargs=(--fuzz-seed "$SEED")
  local envs=(SEANCE_RECORD=0 "SEANCE_WITNESS=$scen")
  [ "$shrink" = 0 ] && envs+=(FOUNDRY_INVARIANT_SHRINK_RUN_LIMIT=0)
  rm -rf cache/invariant seance-out; mkdir -p seance-out
  t0=$(now)
  env "${envs[@]}" forge test --offline --match-contract SeanceWitness --match-test invariant_witness \
    ${seedargs[@]+"${seedargs[@]}"} --json >"$name.out.json" 2>"$name.err.log"
  rc=$?
  t1=$(now)
  secs=$(elapsed "$t0" "$t1")
  local status seqlen
  status=$(jq -r '[.[]|.test_results["invariant_witness()"]][0].status // "none"' "$name.out.json" 2>/dev/null || echo none)
  seqlen=$(jq -r '[.[]|.test_results["invariant_witness()"]][0].counterexample.Sequence[1] | if type=="array" then length else -1 end' "$name.out.json" 2>/dev/null || echo -1)
  local fruns
  fruns=$(jq -r '[.[]|.test_results["invariant_witness()"]][0].kind.Invariant.runs // -1' "$name.out.json" 2>/dev/null || echo -1)
  echo "$secs $rc $status $seqlen $fruns"
}

mkdir -p res   # res/<name> = "secs rc status seqlen" (bash 3.2 on macOS has no associative arrays)
# Fixed-seed pair (default shrinking, then shrink_run_limit=0). forge 1.5.1 does not always reproduce a
# --fuzz-seed campaign exactly when the hit is rare (observed during this task), so the pair is retried
# until both campaigns fail after the same number of completed runs (up to MAX_PAIR_TRIES) to make the shrink share valid.
MAX_PAIR_TRIES=10
mkdir -p attempts
for scen in early rare never; do
  n=0
  while [ "$n" -lt "$MAX_PAIR_TRIES" ]; do
    n=$((n + 1))
    campaign "$scen.fixed.default" "$scen" fixed default >"res/$scen.fixed.default"
    campaign "$scen.fixed.noshrink" "$scen" fixed 0 >"res/$scen.fixed.noshrink"
    set -- $(cat "res/$scen.fixed.default"); d_status=$3; d_runs=$5
    set -- $(cat "res/$scen.fixed.noshrink"); n_status=$3; n_runs=$5
    [ "$d_status" = "$n_status" ] && [ "$d_runs" = "$n_runs" ] && { [ "$scen" = never ] || [ "$d_status" = Failure ]; } && break
  done
  echo "$n" >"attempts/$scen"
  for i in $(seq 1 "$UNSET_REPEATS"); do
    campaign "$scen.unset.$i" "$scen" unset default >"res/$scen.unset.$i"
  done
done

secs_of() { set -- $(cat "res/$1"); echo "$1"; }
status_of() { set -- $(cat "res/$1"); echo "$3"; }
runs_of() { set -- $(cat "res/$1"); echo "$5"; }
len_of() { set -- $(cat "res/$1"); echo "$4"; }

# Replay: regenerate Replay.t.sol from the shrunk Sequence[1] of a default-shrink fixed-seed campaign, build
# (excluded), then time `forge test --match-contract SeanceReplay` with recording ON (SEANCE_RECORD unset).
mkdir -p rp   # rp/<scenario> = replay seconds per repeat, or n/a / build-failed / failed-rcN
replay_for() {
  local scen="$1" json="$1.fixed.default.out.json"
  [ "$(status_of "$scen.fixed.default")" = Failure ] || { echo "n/a" >"rp/$scen"; return; }
  {
    echo '// SPDX-License-Identifier: UNLICENSED'
    echo 'pragma solidity 0.8.28;'
    echo 'import {Test} from "forge-std/Test.sol";'
    echo 'import {Handler} from "./Witness.t.sol";'
    echo 'contract SeanceReplay is Test {'
    echo '    function test_replay() public {'
    echo '        vm.writeFile("./seance-out/records.jsonl", "");'
    echo '        Handler h = new Handler();'
    echo '        h.init(true);'
    jq -r '[.[]|.test_results["invariant_witness()"]][0].counterexample.Sequence[1][]
           | "        vm.prank(vm.parseAddress(\"\(.sender)\")); (bool okN,) = address(h).call(hex\"\(.calldata[2:])\"); require(okN, \"replay call reverted\");"' \
       "$json"
    echo '        assertTrue(h.hit(), "replay did not reach the witness condition");'
    echo '    }'
    echo '}'
  } >test/Replay.t.sol
  # Give each generated local a distinct name (okN -> ok1, ok2, ...).
  perl -i -pe 'if (/okN/) { $n++; s/okN/ok$n/g }' test/Replay.t.sol
  if ! forge build --offline >"replay.$scen.build.log" 2>&1; then echo "build-failed" >"rp/$scen"; return; fi
  local i best="" worst="" s rc out
  local all=()
  for i in $(seq 1 "$REPLAY_REPEATS"); do
    rm -rf seance-out; mkdir -p seance-out
    local a b
    a=$(now)
    SEANCE_WITNESS="$scen" forge test --offline --match-contract SeanceReplay >"replay.$scen.$i.log" 2>&1
    rc=$?
    b=$(now)
    s=$(elapsed "$a" "$b")
    [ "$rc" -eq 0 ] || { echo "failed-rc$rc" >"rp/$scen"; return; }
    all+=("$s")
  done
  echo "${all[*]}" >"rp/$scen"
}
replay_for early
replay_for rare

maxf() { perl -e 'my $m=0; for (@ARGV) { $m=$_ if $_>$m } printf "%.2f",$m' "$@"; }

# Worst campaign: maximum over every measured campaign (all scenarios, both seed modes, default shrink or
# shrink limit 0), because the budget is spent on whichever pair is slow.
worst_campaign=0; worst_name=""
for k in $(ls res); do
  case "$k" in *.noshrink) continue;; esac
  s=$(secs_of "$k")
  if perl -e 'exit($ARGV[0] > $ARGV[1] ? 0 : 1)' "$s" "$worst_campaign"; then worst_campaign="$s"; worst_name="$k"; fi
done
replay_all=""
for k in early rare; do rv=$(cat rp/$k); case "$rv" in n/a|build-failed|failed*) ;; *) replay_all="$replay_all $rv";; esac; done
worst_replay=$(maxf $replay_all)
remaining=$(perl -e 'printf "%.2f", $ARGV[0] - $ARGV[1] - $ARGV[2]' "$DEADLINE_S" "$discovery_secs" "$build_secs")
estimate=$(perl -e 'printf "%.2f", 10 * $ARGV[0] + 10 * $ARGV[1]' "$worst_campaign" "$worst_replay")
shrink_early=$(perl -e 'printf "%.2f", $ARGV[0] - $ARGV[1]' "$(secs_of early.fixed.default)" "$(secs_of early.fixed.noshrink)")
shrink_rare=$(perl -e 'printf "%.2f", $ARGV[0] - $ARGV[1]' "$(secs_of rare.fixed.default)" "$(secs_of rare.fixed.noshrink)")
share_early=$(perl -e 'printf "%.1f", $ARGV[0] > 0 ? 100 * $ARGV[1] / $ARGV[0] : 0' "$(secs_of early.fixed.default)" "$shrink_early")
share_rare=$(perl -e 'printf "%.1f", $ARGV[0] > 0 ? 100 * $ARGV[1] / $ARGV[0] : 0' "$(secs_of rare.fixed.default)" "$shrink_rare")

verdict=PASS; reasons=""
[ "$build_rc" -eq 0 ] || { verdict=FAIL; reasons="$reasons cold forge build exit $build_rc;"; }
[ "$(status_of early.fixed.default)" = Failure ] || { verdict=FAIL; reasons="$reasons early witness campaign did not fail (status $(status_of early.fixed.default));"; }
[ "$(status_of never.fixed.default)" = Success ] || { verdict=FAIL; reasons="$reasons never-hit campaign did not pass (status $(status_of never.fixed.default));"; }
[ -n "$replay_all" ] || { verdict=FAIL; reasons="$reasons no replay was timed;"; }
case "$(cat rp/early)" in failed*|build-failed) verdict=FAIL; reasons="$reasons early replay $(cat rp/early);";; esac
case "$(cat rp/rare)" in failed*|build-failed) verdict=FAIL; reasons="$reasons rare replay $(cat rp/rare);";; esac
fits=yes
timing_applies=yes; [ "$MODE" = native ] || timing_applies=no
if ! perl -e 'exit($ARGV[0] <= $ARGV[1] ? 0 : 1)' "$estimate" "$remaining"; then
  fits=no
  [ "$timing_applies" = yes ] && { verdict=FAIL; reasons="$reasons 10 x worst campaign + 10 x replay = ${estimate}s exceeds remaining budget ${remaining}s;"; }
fi

timing_note="PASS decision uses these native timings."
[ "$MODE" = native ] || timing_note="EMULATED (linux/amd64 under emulation on Apple Silicon) and not representative; not used for the PASS decision."

row() { # name label
  set -- "$1" "$2" $(cat "res/$1")
  echo "| $2 | $3 | $4 | $5 | $6 | $7 |"
}

{
  echo "# 1.9 Risk 8: witness campaign wall-clock time with recording off ($MODE)"
  echo
  echo "**$verdict**"
  echo
  echo "- Mode: **$MODE**. $timing_note"
  echo "- forge: $(forge --version | head -1)"
  echo "- Config: runs=$RUNS, depth=$DEPTH, fail_on_revert=true, \`shrink_run_limit\` NOT set (forge default), gas_limit=1000000000, SEANCE_RECORD=0 (no recordLogs, getRecordedLogs or writeLine), per call GAS_CAP=10,000,000. foundry.toml uses the 1.5 scheme and the 1.7 scheme, as in 1.8."
  echo "- Handler: the 1.8 handler (same per-call work) plus a generated-style witness: \`handler_batchTransfer\` sets \`hit\` when the (function, class) condition holds, and \`invariant_witness\` asserts \`hit\` is false. Scenarios: **early** = any exorcised batchTransfer; **rare** = exorcised batchTransfer from actor 0xA3 with 7 receivers and receiver[0] == address(0) (about 6e-4 per call); **never** = a condition no input satisfies (campaign runs to completion, no shrinking)."
  echo "- Default \`shrink_run_limit\` in this forge: **$default_shrink** (read with \`forge config --json\`; the no-shrink runs set FOUNDRY_INVARIANT_SHRINK_RUN_LIMIT=0, which \`forge config\` reports as $shrink_env_check)."
  echo
  echo "## Budget"
  echo
  echo "- Deadline: ${DEADLINE_S} s. Discovery time from task 1.8 ($MODE, recording ON): ${discovery_secs} s ($discovery_note). Cold build measured in this script: ${build_secs} s (exit $build_rc)."
  echo "- Remaining budget after discovery and build: **${remaining} s**."
  echo
  echo "## Witness campaign wall-clock (only the \`forge test\` invocation, build excluded)"
  echo
  echo "| campaign | seconds | forge exit | status | shrunk sequence length | runs reported |"
  echo "|---|---|---|---|---|---|"
  for scen in early rare never; do
    row "$scen.fixed.default" "$scen, --fuzz-seed $SEED, default shrinking"
    row "$scen.fixed.noshrink" "$scen, --fuzz-seed $SEED, shrink_run_limit=0 (time to first failure)"
    for i in $(seq 1 "$UNSET_REPEATS"); do row "$scen.unset.$i" "$scen, no --fuzz-seed (run $i), default shrinking"; done
  done
  echo
  echo "- Fixed-seed pair attempts needed to get default and shrink_run_limit=0 campaigns that failed at the same reported run: early $(cat attempts/early), rare $(cat attempts/rare), never $(cat attempts/never) (max $MAX_PAIR_TRIES). More than one attempt means forge 1.5.1 did not reproduce the same \`--fuzz-seed $SEED\` campaign on every invocation."
  echo
  echo "## Shrink share (fixed seed: default-shrink time minus shrink_run_limit=0 time)"
  echo
  for scen in early rare; do
    if [ "$(runs_of $scen.fixed.default)" = "$(runs_of $scen.fixed.noshrink)" ] && [ "$(status_of $scen.fixed.default)" = Failure ] && [ "$(status_of $scen.fixed.noshrink)" = Failure ]; then
      eval "sh=\$shrink_$scen; sp=\$share_$scen"
      echo "- $scen: both campaigns failed after $(runs_of $scen.fixed.default) completed runs (forge-reported run count at failure). Shrinking took about ${sh} s of $(secs_of $scen.fixed.default) s (${sp} %), the rest is the calls up to the first failure plus process start."
    else
      echo "- $scen: n/a, the default and no-shrink campaigns did not fail at the same reported run after $(cat attempts/$scen) attempts (default: $(status_of $scen.fixed.default), run $(runs_of $scen.fixed.default); no-shrink: $(status_of $scen.fixed.noshrink), run $(runs_of $scen.fixed.noshrink))."
    fi
  done
  echo "- never: no failure, no shrinking: $(secs_of never.fixed.default) s is the cost of a full runs x depth campaign (the cost of the no-failure case)."
  echo
  echo "## Does forge stop the campaign at the first failure?"
  never_s=$(secs_of never.fixed.default); early_ns=$(secs_of early.fixed.noshrink); rare_ns=$(secs_of rare.fixed.noshrink)
  stops=no
  perl -e 'exit($ARGV[0] < $ARGV[1] ? 0 : 1)' "$early_ns" "$never_s" && stops=yes
  echo "- Time to first failure without shrinking: early ${early_ns} s, rare ${rare_ns} s, against ${never_s} s for a full 256 x 64 campaign with no failure. Stops at first failure (early fails sooner than a full campaign): **$stops**. A failing campaign therefore costs the calls up to the first failing run plus shrinking."
  echo
  echo "## Replay (fresh setUp, recording ON, shrunk Sequence[1] replayed; build excluded)"
  echo
  echo "- early replay seconds (per repeat): $(cat rp/early) (shrunk sequence length $(len_of early.fixed.default))."
  echo "- rare replay seconds (per repeat): $(cat rp/rare) (shrunk sequence length $(len_of rare.fixed.default))."
  echo "- Each replay includes one \`forge test\` process start and a setUp that deploys both contracts; a replay also asserts the witness condition is reached again."
  echo
  echo "## Estimate for 10 pairs"
  echo
  echo "- Worst campaign: ${worst_campaign} s (\`$worst_name\`). Worst replay: ${worst_replay} s."
  echo "- 10 x worst campaign + 10 x worst replay = **${estimate} s** against the remaining budget of **${remaining} s**. Fits: **$fits**."
  echo "- Applies the budget test: $timing_applies. Which outcome applies: $([ "$fits" = yes ] && echo "the native estimate fits, so a deadline in the witness phase is not the expected case and no design change is needed." || echo "the native estimate does not fit; a deadline in the witness phase would be the expected case on this machine.")"
  echo
  echo "## Effect of --fuzz-seed fixed vs unset"
  echo
  for scen in early rare never; do
    u="$(secs_of "$scen.unset.1") $(secs_of "$scen.unset.2") $(secs_of "$scen.unset.3")"
    echo "- $scen: fixed seed $(secs_of $scen.fixed.default) s; unset seed runs: $u s (statuses: $(status_of "$scen.unset.1") $(status_of "$scen.unset.2") $(status_of "$scen.unset.3"))."
  done
  echo "- Observation during development (an earlier, rarer variant of the rare condition with one more receiver constraint, about 1e-4 per call): repeated \`--fuzz-seed 42\` invocations of the same campaign were not always identical (one invocation failed at run 33, the next invocations of the same command passed all 256 runs). A fixed seed therefore does not guarantee that a rare witness is reproduced across invocations in forge 1.5.1. Only the shipped rare condition is measured by this script."
  if [ "$verdict" = FAIL ]; then
    echo
    echo "## FAIL: reasons and recommendation"
    echo
    echo "- Failure reasons:$reasons"
    echo "- Recommendation (not applied): lower \`INVARIANT_RUNS\` used by witness campaigns until 10 x worst campaign + 10 x replay fits in the remaining budget, or document in the design that a \`deadline\` outcome in the witness phase is the expected case."
  fi
  echo
  echo "- Design change needed: $([ "$verdict" = PASS ] && echo none || echo "see the FAIL section")."
} >"$FINDINGS_FILE"

cat "$FINDINGS_FILE"
[ "$verdict" = PASS ]
