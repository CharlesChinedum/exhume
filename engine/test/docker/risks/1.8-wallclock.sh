#!/usr/bin/env bash
# Task 1.8, Risk 7: wall-clock time of discovery with recording on (and off, as a baseline).
# Runs in a scratch copy of fixtures/token (see README). Exits non-zero on FAIL.
# Runs unchanged in Docker; the mode label comes from $MODE. Docker timing on Apple Silicon is emulated and is
# not used for the PASS decision; the PASS threshold applies to MODE=native only.
set -uo pipefail

RUNS=256
DEPTH=64
LIMIT_S=150
SEED=42
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/1.8-wallclock"
: "${FINDINGS_FILE:?}" "${MODE:?}" "${FORGE_STD_DIR:?}"
OUT_DIR="$(dirname "$FINDINGS_FILE")"

now() { perl -MTime::HiRes=time -e 'printf "%.3f\n", time'; }
elapsed() { perl -e 'printf "%.2f", $ARGV[1] - $ARGV[0]' "$1" "$2"; }
div() { perl -e 'printf "%.6f", $ARGV[1] ? $ARGV[0] / $ARGV[1] : 0' "$1" "$2"; }

# foundry.toml: the 1.5 scheme (exact pins, optimizer off, runs=1) and the 1.7 scheme (allow_paths, absolute
# forge-std restriction, test/** restriction), plus the design's discovery settings.
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
  { paths = "src/legacy/LegacyToken.sol", version = "=0.4.19", min_optimizer_runs = 200 },
  { paths = "src/port/PortToken.sol", version = "=0.8.28" },
  { paths = "$FORGE_STD_DIR/src/**", version = "=0.8.28" },
  { paths = "test/**", version = "=0.8.28" },
]

[profile.default.invariant]
runs = $RUNS
depth = $DEPTH
fail_on_revert = true
shrink_run_limit = 0
EOF
# 1.5's note: the legacy file is selected into the optimizer profile by min_optimizer_runs. Keep the legacy
# optimizer OFF here (as in the BEC build): drop min_optimizer_runs from the legacy entry.
sed -i.bak 's/, min_optimizer_runs = 200 }/ }/' foundry.toml && rm -f foundry.toml.bak
printf 'forge-std/=%s/src/\n' "$FORGE_STD_DIR" >remappings.txt

mkdir -p test seance-out
cp "$SRC_DIR/Bench.t.sol" test/Bench.t.sol
rm -rf out cache

# Build timing, cold then warm (solc 0.4.19 and 0.8.28 are already installed; --offline).
t0=$(now); forge build --offline >build.cold.log 2>&1; build_cold_rc=$?; t1=$(now)
build_cold=$(elapsed "$t0" "$t1")
t0=$(now); forge build --offline >build.warm.log 2>&1; build_warm_rc=$?; t1=$(now)
build_warm=$(elapsed "$t0" "$t1")

# One timed campaign. $1 = label, $2 = SEANCE_RECORD value. Sets <label>_* variables.
run_campaign() {
  local label="$1" rec="$2" log="campaign.$1.log"
  rm -rf seance-out cache/invariant; mkdir -p seance-out
  local t0 t1
  t0=$(now)
  SEANCE_RECORD="$rec" forge test --offline --match-contract SeanceBench --match-test invariant_discovery \
    --fuzz-seed "$SEED" -vv >"$log" 2>&1
  eval "${label}_rc=$?"
  t1=$(now)
  eval "${label}_secs=$(elapsed "$t0" "$t1")"
  local line
  line="$(grep -E '\[(PASS|FAIL[^]]*)\] invariant_discovery' "$log" | head -1)"
  eval "${label}_line=\$line"
  eval "${label}_calls=$(sed -nE 's/.*calls: ([0-9]+).*/\1/p' <<<"$line" | head -1 | grep . || echo -1)"
  eval "${label}_reverts=$(sed -nE 's/.*reverts: ([0-9]+).*/\1/p' <<<"$line" | head -1 | grep . || echo -1)"
  eval "${label}_runs=$(sed -nE 's/.*runs: ([0-9]+).*/\1/p' <<<"$line" | head -1 | grep . || echo -1)"
}

run_campaign on 1
rec=seance-out/records.jsonl
lines=-1; [ -f "$rec" ] && lines=$(wc -l <"$rec" | tr -d ' ')
bytes=-1; [ -f "$rec" ] && bytes=$(wc -c <"$rec" | tr -d ' ')
cls() { if [ -f "$rec" ]; then grep -c "\"class\":\"$1\"" "$rec" || true; else echo 0; fi; }
c_match=$(cls match); c_reason=$(cls reason-modernised); c_exo=$(cls exorcised); c_bug=$(cls port-bug)
dbl_rev=0; [ -f "$rec" ] && dbl_rev=$(grep -c '"legacy":{"ok":false.*"port":{"ok":false' "$rec")
both_ok=0; [ -f "$rec" ] && both_ok=$(grep -c '"legacy":{"ok":true.*"port":{"ok":true' "$rec")
zeros=0; [ -f "$rec" ] && zeros=$(grep -c '^{"idx":0,' "$rec")
cp campaign.on.log campaign.on.keep.log

run_campaign off 0
off_lines=-1; [ -f "$rec" ] && off_lines=$(wc -l <"$rec" | tr -d ' ')
off_exists=no; [ -f "$rec" ] && off_exists=yes

expected_lines=$((RUNS * DEPTH + DEPTH))
executed=$((RUNS * DEPTH + DEPTH))
per_call_on=$(div "$on_secs" "$on_calls")
per_call_on_exec=$(div "$on_secs" "$executed")
per_call_off=$(div "$off_secs" "$off_calls")
overhead_total=$(perl -e 'printf "%.2f", $ARGV[0] - $ARGV[1]' "$on_secs" "$off_secs")
overhead_per_call=$(perl -e 'printf "%.6f", ($ARGV[2] ? ($ARGV[0] - $ARGV[1]) / $ARGV[2] : 0)' "$on_secs" "$off_secs" "$on_calls")
replay_share=$(perl -e 'printf "%.2f", 100 * $ARGV[0] / $ARGV[1]' "$DEPTH" "$executed")
replay_secs=$(perl -e 'printf "%.2f", $ARGV[0] * $ARGV[1] / $ARGV[2]' "$on_secs" "$DEPTH" "$executed")

verdict=PASS; reasons=""
[ "$build_cold_rc" -eq 0 ] || { verdict=FAIL; reasons="$reasons cold forge build exit $build_cold_rc;"; }
[ "$build_warm_rc" -eq 0 ] || { verdict=FAIL; reasons="$reasons warm forge build exit $build_warm_rc;"; }
[ "$on_rc" -eq 0 ] || { verdict=FAIL; reasons="$reasons recording-on forge test exit $on_rc;"; }
[ "$off_rc" -eq 0 ] || { verdict=FAIL; reasons="$reasons recording-off forge test exit $off_rc;"; }
[ "$on_calls" -eq $((RUNS * DEPTH)) ] || { verdict=FAIL; reasons="$reasons recording-on forge reported $on_calls calls != runs*depth;"; }
[ "$off_calls" -eq $((RUNS * DEPTH)) ] || { verdict=FAIL; reasons="$reasons recording-off forge reported $off_calls calls != runs*depth;"; }
[ "$on_reverts" -eq 0 ] || { verdict=FAIL; reasons="$reasons handler reverted ($on_reverts reverts reported);"; }
[ "$lines" -eq "$expected_lines" ] || { verdict=FAIL; reasons="$reasons record file has $lines lines != runs*depth+depth ($expected_lines);"; }
[ "$off_exists" = no ] || [ "$off_lines" -eq 0 ] || { verdict=FAIL; reasons="$reasons recording-off wrote $off_lines lines;"; }
[ "$c_exo" -gt 0 ] || { verdict=FAIL; reasons="$reasons no targeted overflow produced an exorcised record (fixture not exercising the legacy-succeeds path);"; }
[ "$dbl_rev" -gt 0 ] || { verdict=FAIL; reasons="$reasons no double-revert calls in the mix;"; }
timing_applies=yes
[ "$MODE" = native ] || timing_applies=no
if [ "$timing_applies" = yes ]; then
  perl -e 'exit($ARGV[0] < $ARGV[1] ? 0 : 1)' "$on_secs" "$LIMIT_S" \
    || { verdict=FAIL; reasons="$reasons native recording-on total ${on_secs}s is not under ${LIMIT_S}s;"; }
fi

timing_note="PASS decision uses this native total."
[ "$MODE" = native ] || timing_note="EMULATED (linux/amd64 under emulation on Apple Silicon) and not representative; not used for the PASS decision."

{
  echo "# 1.8 Risk 7: wall-clock time of discovery with recording on ($MODE)"
  echo
  echo "**$verdict**"
  echo
  echo "- Mode: **$MODE**. $timing_note"
  echo "- forge: $(forge --version | head -1)"
  echo "- Config: runs=$RUNS, depth=$DEPTH, fail_on_revert=true, shrink_run_limit=0, gas_limit=1000000000, --fuzz-seed $SEED, GAS_CAP=10,000,000 per call, legacy optimizer off. foundry.toml uses the 1.5 scheme (exact pins, per-file restrictions) and the 1.7 scheme (remappings.txt, allow_paths, absolute forge-std restriction)."
  echo "- Handler: two functions (\`handler_transfer\`, \`handler_batchTransfer\`), each makes per call: one capped low-level call to the legacy deployment and one to the port deployment (same sender, calldata, value, warp/roll), two capped \`staticcall\` balanceOf reads (actor on each side), \`vm.recordLogs\` + \`vm.getRecordedLogs\` per side, \`vm.deal\` before each side when ether is attached (about 1 in 8 transfer calls, both sides revert as the functions are non-payable), a comparison of success flags, return data, log hashes and state reads, a classification, and one \`vm.writeLine\` of one JSON line (about $((bytes / (lines > 0 ? lines : 1))) bytes). batchTransfer uses a targeted value \`max/cnt + 1\` for about half of its calls with cnt >= 2."
  echo "- Deviation from the design's handler, worst case for timing: the benchmark does not set \`stopped\` after an \`exorcised\` record, so every call does the full work and every sequence writes depth lines. It writes no setup (idx == -1) records, so the expected line count is exactly runs*depth + depth."
  echo
  echo "## Build (excluded from the campaign timings)"
  echo
  echo "| build | seconds | exit |"
  echo "|---|---|---|"
  echo "| cold (fresh scratch dir, no cache/ or out/; solc 0.4.19 and 0.8.28 already installed) | $build_cold | $build_cold_rc |"
  echo "| warm (second \`forge build\`, cache hit) | $build_warm | $build_warm_rc |"
  echo
  echo "## Campaign wall-clock (only the \`forge test\` invocation, build excluded)"
  echo
  echo "| recording | total seconds | calls forge reported | seconds per reported call | runs reported | reverts reported | exit |"
  echo "|---|---|---|---|---|---|---|"
  echo "| ON (recordLogs, getRecordedLogs, writeLine) | $on_secs | $on_calls | $per_call_on | $on_runs | $on_reverts | $on_rc |"
  echo "| OFF (SEANCE_RECORD=0, baseline) | $off_secs | $off_calls | $per_call_off | $off_runs | $off_reverts | $off_rc |"
  echo
  echo "- Recording overhead: $overhead_total s total, $overhead_per_call s per call (ON minus OFF, divided by $on_calls reported calls)."
  echo "- Threshold: native recording-ON total must be under ${LIMIT_S} s. Observed ${on_secs} s in $MODE mode; the threshold is applied: $timing_applies."
  echo "- Forge result lines: ON \`$on_line\`; OFF \`$off_line\`."
  echo
  echo "## Record file (recording ON)"
  echo
  echo "- Lines: $lines (expected runs*depth + depth = $expected_lines); bytes: $bytes; lines with idx 0: $zeros. Recording OFF: file present=$off_exists, lines=$([ "$off_lines" -eq -1 ] && echo "0 (file not created)" || echo "$off_lines") (expected 0)."
  echo "- Classes over all lines: match=$c_match, reason-modernised=$c_reason, exorcised=$c_exo, port-bug=$c_bug (port-bug lines are expected once legacy's wrapped balances make the two sides diverge; the benchmark does not stop on them)."
  echo "- Call mix: both sides reverted=$dbl_rev, both sides succeeded=$both_ok, legacy-succeeded-port-reverted=$c_exo (targeted overflow reaching the legacy side)."
  echo
  echo "## Does the post-campaign replay inflate the time?"
  echo
  echo "- Foundry executes $executed handler calls in total ($((RUNS * DEPTH)) reported plus a $DEPTH-call replay of the final run, which matches the $lines record lines). The replay is $replay_share % of the executed calls, so by call share it adds about $replay_secs s of the $on_secs s total (estimate: call share times total, assuming equal cost per call; no separate replay timing was taken)."
  if [ "$verdict" = FAIL ]; then
    echo
    echo "## FAIL: failure reasons and mitigations"
    echo
    echo "- Failure reasons:$reasons"
    echo "- If the failure is the time threshold, apply the design's wall-clock mitigations in this order and update the design: (1) keep runs=256 and depth=64 and raise the default timeout for graveyard runs; (2) skip the per-call state read when the call reverted on both sides (buffered \`vm.writeFile\` is NOT available, design decision 13); (3) lower depth while keeping runs equal to \`report.runs\` and \`report.depth\`. (The task text also lists buffered writes as a step; the design rejects it.)"
  fi
  echo
  echo "- Design change needed: $([ "$verdict" = PASS ] && echo none || echo "see the FAIL section")."
} >"$FINDINGS_FILE"

# Harness name (matches 1.2/1.3 convention) when the harness chose a different file.
[ "$(basename "$FINDINGS_FILE")" = "1.8.$MODE.md" ] || cp "$FINDINGS_FILE" "$OUT_DIR/1.8.$MODE.md"
cat "$FINDINGS_FILE"
[ "$verdict" = PASS ]
