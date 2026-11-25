#!/usr/bin/env bash
# Task 1.2, Risk 1: vm.writeLine inside invariant runs with scoped fs_permissions.
# Corrected criterion: runs*depth campaign lines + exactly one replayed sequence identical to the last campaign sequence.
# Runs in a scratch copy of fixtures/token (see README). Exits non-zero on FAIL.
set -uo pipefail

RUNS=256
DEPTH=64
EXPECTED=$((RUNS * DEPTH))
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/1.2-writeline"
: "${FINDINGS_FILE:?}"

mkdir -p test seance-out
cp "$SRC_DIR/WriteLine.t.sol" test/WriteLine.t.sol

# Keys must precede any table header; the harness already appended allow_paths to [profile.default].
cat >>foundry.toml <<EOF
fs_permissions = [{ access = "read", path = "./out" }, { access = "read-write", path = "./seance-out" }]

[profile.default.invariant]
runs = $RUNS
depth = $DEPTH
fail_on_revert = false
EOF

inv_log="$(mktemp)"; out_log="$(mktemp)"
forge test --match-contract WriteLineInvariant -vv >"$inv_log" 2>&1; inv_rc=$?
forge test --match-contract OutsideWrite -vv >"$out_log" 2>&1; out_rc=$?

lines=-1; [ -f seance-out/records.jsonl ] && lines=$(wc -l <seance-out/records.jsonl | tr -d ' ')
outside_files=""
for f in outside.txt outside2.txt src/injected.txt; do [ -e "$f" ] && outside_files="$outside_files $f"; done
perm_text="$(grep -E 'OUTSIDE_(ERR|WRITE_SUCCEEDED)' "$out_log" | sed 's/^ *//')"
perm_err_inv="$(grep -iE 'permission|not allowed|denied' "$inv_log" | head -3)"
summary_inv="$(grep -E 'invariant_always_true|Suite result|runs:' "$inv_log" | head -5)"

# Corrected criterion: RUNS*DEPTH campaign lines (the first RUNS sequences, counted by idx == 0 starts),
# then exactly one replayed sequence (DEPTH lines) identical, line for line, to the last campaign sequence.
rec=seance-out/records.jsonl
starts=""; [ -f "$rec" ] && starts="$(grep -n '^{"idx":0,' "$rec" | cut -d: -f1 | tr '\n' ' ')"
n_starts=$(wc -w <<<"$starts" | tr -d ' ')
replay_start=-1; last_start=-1; replay_len=-1; last_len=-1; replay_diff="not checked"; replay_ok=no
if [ "$n_starts" -eq $((RUNS + 1)) ]; then
  last_start=$(cut -d' ' -f"$RUNS" <<<"$starts"); replay_start=$(cut -d' ' -f"$((RUNS + 1))" <<<"$starts")
  last_len=$((replay_start - last_start)); replay_len=$((lines - replay_start + 1))
  campaign_lines=$((replay_start - 1))
  last_seq="$(sed -n "${last_start},$((replay_start - 1))p" "$rec")"
  replay_seq="$(sed -n "${replay_start},\$p" "$rec")"
  replay_diff="$(diff <(echo "$last_seq") <(echo "$replay_seq") | head -3 | tr '\n' ' ')"
  if [ "$campaign_lines" -eq "$EXPECTED" ] && [ "$replay_len" -eq "$DEPTH" ] && [ "$last_len" -eq "$DEPTH" ] && [ -z "$replay_diff" ]; then
    replay_ok=yes; replay_diff="none"
  else
    # name the first differing line (1-based within the sequence)
    first=$(paste -d'\n' <(echo "$last_seq") <(echo "$replay_seq") | awk 'NR%2==1{a=$0;next}{n++; if(a!=$0){print "line " n ": campaign=" a " replay=" $0; exit}}')
    replay_diff="${first:-length differs: campaign last sequence $last_len lines, trailing $replay_len lines, campaign lines $campaign_lines}"
  fi
fi
tail_report="idx==0 starts: $n_starts (expected $((RUNS + 1)): $RUNS campaign + 1 replay); last campaign sequence at line $last_start ($last_len lines); trailing replay at line $replay_start ($replay_len lines); first difference: $replay_diff"
verdict=PASS; reasons=""
[ "$inv_rc" -eq 0 ] || { verdict=FAIL; reasons="$reasons invariant forge test exit $inv_rc;"; }
[ "$lines" -eq $((EXPECTED + DEPTH)) ] || { verdict=FAIL; reasons="$reasons line count $lines != $EXPECTED campaign + $DEPTH replay;"; }
[ "$replay_ok" = yes ] || { verdict=FAIL; reasons="$reasons trailing sequence is not an exact replay of the last campaign sequence ($tail_report);"; }
[ -z "$perm_err_inv" ] || { verdict=FAIL; reasons="$reasons permission error text in invariant run;"; }
[ "$out_rc" -eq 0 ] || { verdict=FAIL; reasons="$reasons outside-write test exit $out_rc;"; }
grep -q OUTSIDE_WRITE_SUCCEEDED "$out_log" && { verdict=FAIL; reasons="$reasons outside write succeeded;"; }
[ -z "$outside_files" ] || { verdict=FAIL; reasons="$reasons files created outside seance-out:$outside_files;"; }
[ "$(grep -c 'OUTSIDE_ERR' "$out_log")" -eq 3 ] || { verdict=FAIL; reasons="$reasons expected 3 permission errors;"; }

{
  echo "# 1.2 Risk 1: vm.writeLine in invariant runs ($MODE)"
  echo
  echo "**$verdict**"
  echo
  echo "- forge: $(forge --version | head -1)"
  echo "- Config: runs=$RUNS, depth=$DEPTH, fail_on_revert=false, fs_permissions = read ./out, read-write ./seance-out"
  echo "- Expected lines: $EXPECTED campaign + $DEPTH replay = $((EXPECTED + DEPTH)). Observed lines in seance-out/records.jsonl: $lines"
  echo "- Replay check (corrected criterion, part of the verdict): $tail_report. Replay identical line for line: $replay_ok"
  echo "- Invariant forge exit code: $inv_rc"
  echo "- Permission error text in invariant run: ${perm_err_inv:-none}"
  echo "- Outside-write attempts (expect 3 errors):"
  echo '```'
  echo "$perm_text"
  echo '```'
  echo "- Files created outside ./seance-out: ${outside_files:-none}"
  echo "- Invariant output excerpt:"
  echo '```'
  echo "$summary_inv"
  echo '```'
  if [ "$verdict" = FAIL ]; then
    echo "- Failure reasons:$reasons"
    echo "- Design change needed: see tasks.md 1.2 findings (keep vm.writeLine; Report_Builder verifies the single trailing replay)."
  else
    echo "- Design change needed: none beyond tasks.md 1.2 findings (keep vm.writeLine; Report_Builder drops and verifies the single trailing replay)."
  fi
} >"$FINDINGS_FILE"

# The harness names the file after the script; also write the sub-task name the task asks for.
cp "$FINDINGS_FILE" "$(dirname "$FINDINGS_FILE")/1.2.$MODE.md"
cat "$FINDINGS_FILE"
[ "$verdict" = PASS ]
