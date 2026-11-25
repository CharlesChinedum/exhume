#!/usr/bin/env bash
# Task 1.3, Risk 2: handler storage reverts per invariant run; setUp runs once per forge process.
# Runs in a scratch copy of fixtures/token (see README). Exits non-zero on FAIL.
set -uo pipefail

RUNS=256
DEPTH=64
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/1.3-handler-storage"
: "${FINDINGS_FILE:?}"

mkdir -p test seance-out
cp "$SRC_DIR/Storage.t.sol" test/Storage.t.sol

cat >>foundry.toml <<EOF
fs_permissions = [{ access = "read", path = "./out" }, { access = "read-write", path = "./seance-out" }]

[profile.default.invariant]
runs = $RUNS
depth = $DEPTH
fail_on_revert = false
EOF

inv_log="$(mktemp)"
forge test --match-contract StorageInvariant -vv >"$inv_log" 2>&1; inv_rc=$?

rec=seance-out/records.jsonl
total=-1; [ -f "$rec" ] && total=$(wc -l <"$rec" | tr -d ' ')
markers=0; [ -f "$rec" ] && markers=$(grep -c '"idx":-1' "$rec")
first_is_marker=no; [ -f "$rec" ] && [ "$(head -n 1 "$rec")" = '{"idx":-1,"kind":"setup"}' ] && first_is_marker=yes

# Call lines (idx >= 0) in file order. Campaign = first RUNS*DEPTH call lines (RUNS sequences);
# anything after that is the post-campaign replay and is checked separately.
calls_f="$(mktemp)"; camp_f="$(mktemp)"; trail_f="$(mktemp)"
grep -v '"idx":-1' "$rec" >"$calls_f" 2>/dev/null
head -n $((RUNS * DEPTH)) "$calls_f" >"$camp_f"
tail -n +$((RUNS * DEPTH + 1)) "$calls_f" >"$trail_f"
calls=$(wc -l <"$calls_f" | tr -d ' ')
camp=$(wc -l <"$camp_f" | tr -d ' ')
trail=$(wc -l <"$trail_f" | tr -d ' ')
idx_of() { sed -E 's/^\{"idx":([0-9]+),.*/\1/' "$1"; }
stats="$(idx_of "$camp_f" | awk -v d="$DEPTH" '
  { n++; if ($1 == 0) zeros++; if ($1 != (n-1) % d) bad++; if ($1 > mx) mx = $1 }
  END { printf "zeros=%d bad=%d max=%d", zeros, bad, mx+0 }')"
zeros=$(sed -E 's/.*zeros=([0-9]+).*/\1/' <<<"$stats")
bad=$(sed -E 's/.*bad=([0-9]+).*/\1/' <<<"$stats")
maxidx=$(sed -E 's/.*max=([0-9]+).*/\1/' <<<"$stats")
: "${zeros:=0}" "${bad:=-1}"
# Distinct sequences in the campaign (makes the replay-identity check meaningful).
distinct=$(awk -v d="$DEPTH" '{ k = k $0 "|"; if (NR % d == 0) { print k; k = "" } }' "$camp_f" | sort -u | wc -l | tr -d ' ')
summary_inv="$(grep -E 'invariant_always_true|Suite result' "$inv_log" | head -5)"

# Replay check: the trailing lines must be exactly one sequence starting at idx 0 and
# identical to the last kept campaign sequence.
replay="no trailing lines"
replay_ok=no
if [ "$trail" -eq 0 ]; then
  replay_ok=none
elif [ "$trail" -eq "$DEPTH" ]; then
  first_trail_idx=$(head -n 1 "$trail_f" | sed -E 's/^\{"idx":([0-9]+),.*/\1/')
  if [ "$(tail -n "$DEPTH" "$camp_f" | cksum)" = "$(cksum <"$trail_f")" ] && [ "$first_trail_idx" = 0 ]; then
    replay_ok=yes
    replay="$trail trailing lines = exactly one sequence, starts at idx 0, byte-identical to the last kept campaign sequence. Marker count stays $markers and the record file was not truncated, so the replay did not re-run setUp; it ran from restored post-setUp handler storage (idx back to 0)"
  else
    replay="$trail trailing lines but NOT identical to the last campaign sequence (or first idx is $first_trail_idx)"
  fi
else
  replay="unexpected $trail trailing call lines (expected 0 or $DEPTH)"
fi

verdict=PASS; reasons=""
[ "$inv_rc" -eq 0 ] || { verdict=FAIL; reasons="$reasons invariant forge test exit $inv_rc;"; }
[ "$markers" -eq 1 ] || { verdict=FAIL; reasons="$reasons setup marker count $markers != 1 over the whole process;"; }
[ "$first_is_marker" = yes ] || { verdict=FAIL; reasons="$reasons first line is not the setup marker;"; }
[ "$camp" -eq $((RUNS * DEPTH)) ] || { verdict=FAIL; reasons="$reasons campaign has $camp call lines != runs*depth;"; }
[ "$bad" -eq 0 ] || { verdict=FAIL; reasons="$reasons $bad campaign lines whose idx != position mod depth (counter did not restart at 0 every run);"; }
[ "$zeros" -eq "$RUNS" ] || { verdict=FAIL; reasons="$reasons campaign idx==0 count $zeros != runs $RUNS;"; }
[ "$distinct" -gt 1 ] || { verdict=FAIL; reasons="$reasons campaign sequences are not distinct, replay check meaningless;"; }
{ [ "$replay_ok" = yes ] || [ "$replay_ok" = none ]; } || { verdict=FAIL; reasons="$reasons trailing lines are not one replay of the last kept sequence;"; }

{
  echo "# 1.3 Risk 2: handler storage per run, setUp once per process ($MODE)"
  echo
  echo "**$verdict**"
  echo
  echo "- forge: $(forge --version | head -1)"
  echo "- Config: runs=$RUNS, depth=$DEPTH, fail_on_revert=false; handler never reverts; post-setUp idx = 0"
  echo "- Total lines in seance-out/records.jsonl: $total (runs*depth = $((RUNS * DEPTH)))"
  echo "- Setup marker lines (idx == -1) in the whole process: $markers (expected 1); first line is the marker: $first_is_marker"
  echo "- Call lines: $calls = campaign $camp (first runs*depth) + trailing $trail"
  echo "- Campaign: lines with idx == 0 (sequence starts): $zeros (expected $RUNS); lines where idx != position mod $DEPTH: $bad; max idx: $maxidx; distinct sequences: $distinct"
  echo "- Post-campaign replay: $replay"
  echo "- Invariant forge exit code: $inv_rc"
  echo "- Invariant output excerpt:"
  echo '```'
  echo "$summary_inv"
  echo '```'
  if [ "$verdict" = FAIL ]; then
    echo "- Failure reasons:$reasons"
    echo "- Design change needed: decision 4 (idx == 0 as sequence boundary) and decision 10 (setup records idx == -1 once per process) need a different mechanism, for example a per-call sequence id derived outside handler storage (such as a counter written to a file or a cheatcode-visible value) in place of handler-storage idx."
  else
    echo "- Design change needed: none."
  fi
} >"$FINDINGS_FILE"

cp "$FINDINGS_FILE" "$(dirname "$FINDINGS_FILE")/1.3.$MODE.md"
cat "$FINDINGS_FILE"
[ "$verdict" = PASS ]
