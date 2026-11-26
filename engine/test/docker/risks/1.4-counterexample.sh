#!/usr/bin/env bash
# Task 1.4, Risk 3: `forge test --json` exposes a failed invariant's counterexample as an ordered
# handler-call list (hex calldata + sender); a passing run has none.
# Runs in a scratch copy of fixtures/token (see README). Exits non-zero on FAIL.
# Native runs also save the two JSON outputs as engine/test/fixtures/forge-json/{failing,passing}.json.
set -uo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/1.4-counterexample"
FIXTURES_OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/fixtures/forge-json"
: "${FINDINGS_FILE:?}"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }

HERE="${HERE:?}"
# shellcheck source=../lib.sh
. "$HERE/lib.sh"
SEED="${SEED:-0x1badc0de}"
ALT_SEED=0x2badc0de
FIND_DIR="$(dirname "$FINDINGS_FILE")"
# Every forge run gets a fresh scratch copy: forge replays saved failures from cache/invariant.
fresh() { local d; d="$(mktemp -d)"; make_scratch "$d"; mkdir -p "$d/test"; cp "$SRC_DIR/Witness.t.sol" "$d/test/Witness.t.sol"; echo "$d"; }
run_in() { # dir contract seed outfile errfile
  (cd "$1" && forge test --json --fuzz-seed "$3" --match-contract "^$2\$" >"$4" 2>"$5"); }
fail_json=failing.json; pass_json=passing.json
fdir="$(fresh)"; pdir="$(fresh)"
# stdout is the JSON; stderr (compiler notes, warnings) is kept apart so the JSON is not polluted.
run_in "$fdir" WitnessFailing "$SEED" "$PWD/$fail_json" "$PWD/failing.err"; fail_rc=$?
run_in "$pdir" WitnessPassing "$SEED" "$PWD/$pass_json" "$PWD/passing.err"; pass_rc=$?
jq -e . "$fail_json" >/dev/null 2>&1 && fail_valid=yes || fail_valid=no
jq -e . "$pass_json" >/dev/null 2>&1 && pass_valid=yes || pass_valid=no
T='.[]|.test_results["invariant_witness()"]'
f_status=$(jq -r "$T|.status" "$fail_json" 2>/dev/null)
p_status=$(jq -r "$T|.status" "$pass_json" 2>/dev/null)
f_ce_type=$(jq -r "$T|.counterexample|type" "$fail_json" 2>/dev/null)
p_ce_type=$(jq -r "$T|.counterexample|type" "$pass_json" 2>/dev/null)
f_ce_keys=$(jq -r "$T|.counterexample|if type==\"object\" then keys|join(\",\") else \"-\" end" "$fail_json" 2>/dev/null)
# Real shape: counterexample.Sequence = [<original length>, [<call>, ...]]
orig_len=$(jq -r "$T|.counterexample.Sequence[0]" "$fail_json" 2>/dev/null)
n_calls=$(jq -r "$T|.counterexample.Sequence[1]|length" "$fail_json" 2>/dev/null)
call_keys=$(jq -r "$T|.counterexample.Sequence[1][0]|keys|join(\",\")" "$fail_json" 2>/dev/null)
funcs=$(jq -r "$T|[.counterexample.Sequence[1][].func_name]|join(\" -> \")" "$fail_json" 2>/dev/null)
all_hex=$(jq -r "$T|[.counterexample.Sequence[1][]|(.calldata|test(\"^0x[0-9a-f]+\$\")) and (.sender|test(\"^0x[0-9a-fA-F]{40}\$\"))]|all" "$fail_json" 2>/dev/null)
calls_table=$(jq -r "$T|.counterexample.Sequence[1]|to_entries[]|\"  \(.key). sender=\(.value.sender) addr=\(.value.addr) func=\(.value.signature) raw_args=\(.value.raw_args) calldata=\(.value.calldata)\"" "$fail_json" 2>/dev/null)
p_calls=$(jq -r "$T|(.counterexample.Sequence[1]? // [])|length" "$pass_json" 2>/dev/null)
stdout_head=$(head -c 1 "$fail_json")

# arm must precede fire (the witness needs that order); noise calls may or may not survive shrinking.
order_ok=$(jq -r "$T|[.counterexample.Sequence[1][].func_name]|(index(\"arm\") != null and index(\"fire\") != null and index(\"arm\") < index(\"fire\"))" "$fail_json" 2>/dev/null)
shrunk=no; [ "${n_calls:-0}" -lt "${orig_len:-0}" ] 2>/dev/null && shrunk=yes

seq_expr="$T|{originalLength:.counterexample.Sequence[0],calls:[.counterexample.Sequence[1][]|{sender,func_name,calldata}]}"
seq_file="$FIND_DIR/1.4.$MODE.sequence.json"
jq -S --arg seed "$SEED" "$seq_expr | {seed:\$seed} + ." "$fail_json" >"$seq_file" 2>/dev/null
# Negative check: reusing a directory replays the cached failure (a different seed must not change the sequence).
cache_file=$(find "$fdir/cache/invariant" -type f 2>/dev/null | head -1)
run_in "$fdir" WitnessFailing "$ALT_SEED" "$PWD/reuse.json" "$PWD/reuse.err"
calls_expr="$T|[.counterexample.Sequence[1][]|{sender,func_name,calldata}]"
reuse_seq=$(jq -cS "$calls_expr" reuse.json 2>/dev/null)
orig_seq=$(jq -cS "$calls_expr" "$fail_json" 2>/dev/null)
reuse_orig_len=$(jq -r "$T|.counterexample.Sequence[0]" reuse.json 2>/dev/null)
reuse_reason=$(jq -r "$T|.reason" reuse.json 2>/dev/null)
fresh_reason=$(jq -r "$T|.reason" "$fail_json" 2>/dev/null)
edir="$(fresh)"; run_in "$edir" WitnessFailing "$ALT_SEED" "$PWD/alt.json" "$PWD/alt.err"
alt_seq=$(jq -cS "$calls_expr" alt.json 2>/dev/null)
rm -rf "$edir"
replayed=no; [ -n "$cache_file" ] && [ -n "$reuse_seq" ] && [ "$reuse_seq" = "$orig_seq" ] && replayed=yes
alt_differs=no; [ "$alt_seq" != "$orig_seq" ] && alt_differs=yes
# Shape-only comparison with the native fixtures (engine/test/fixtures/forge-json/{failing,passing}.json).
# Shrunk sequences are NOT compared: forge 1.5.1's fuzzer is not reproducible from a seed (task 1.11).
# Projection: key sets and value types (arrays: the set of distinct element shapes, so lengths may differ).
# traces and metrics key names depend on the run, so only their element shapes and the entry key set are compared.
SHAPE='def sh: if type=="object" then with_entries(.value|=sh) elif type=="array" then (map(sh)|unique) else type end;
  [.[]|{result_keys:(.test_results["invariant_witness()"]|keys), duration:(.duration|sh),
        status:(.test_results["invariant_witness()"].status|type), reason:(.test_results["invariant_witness()"].reason|type),
        counterexample:(.test_results["invariant_witness()"].counterexample|sh),
        kind_keys:(.test_results["invariant_witness()"].kind|keys),
        invariant_keys:(.test_results["invariant_witness()"].kind.Invariant|keys),
        metrics_shapes:([.test_results["invariant_witness()"].kind.Invariant.metrics[]|sh]|unique)}]'
NATIVE_FIX="${NATIVE_FIX_DIR:-/fixtures/forge-json}"
[ -d "$NATIVE_FIX" ] || NATIVE_FIX="$FIXTURES_OUT"
shape_cmp() { # name file
  local nf="$NATIVE_FIX/$1.json" a b
  [ -f "$nf" ] || { echo "no native fixture $nf"; return 1; }
  a=$(jq -cS "$SHAPE" "$nf" 2>/dev/null); b=$(jq -cS "$SHAPE" "$2" 2>/dev/null)
  [ -n "$a" ] && [ "$a" = "$b" ] && { echo "SAME"; return 0; }
  echo "DIFFERENT. native: $a; $MODE: $b"; return 1
}
fail_shape=$(shape_cmp failing "$fail_json"); fail_shape_rc=$?
pass_shape=$(shape_cmp passing "$pass_json"); pass_shape_rc=$?
cmp_result="failing JSON shape vs native fixture: $fail_shape; passing JSON shape vs native fixture: $pass_shape"
saved=no
if [ "$MODE" = native ] && [ -n "${FIXTURES_OUT:-}" ] && [ "$fail_valid" = yes ] && [ "$pass_valid" = yes ]; then
  mkdir -p "$FIXTURES_OUT" && cp "$fail_json" "$FIXTURES_OUT/failing.json" && cp "$pass_json" "$FIXTURES_OUT/passing.json" && saved=yes
fi

verdict=PASS; reasons=""
[ "$fail_rc" -ne 0 ] || { verdict=FAIL; reasons="$reasons failing run exited 0;"; }
[ "$pass_rc" -eq 0 ] || { verdict=FAIL; reasons="$reasons passing run exited $pass_rc;"; }
[ "$fail_valid" = yes ] && [ "$pass_valid" = yes ] || { verdict=FAIL; reasons="$reasons stdout is not a single valid JSON document (failing: $fail_valid, passing: $pass_valid);"; }
[ "$f_status" = Failure ] || { verdict=FAIL; reasons="$reasons failing status is '$f_status';"; }
[ "$p_status" = Success ] || { verdict=FAIL; reasons="$reasons passing status is '$p_status';"; }
[ "${n_calls:-0}" -ge 2 ] 2>/dev/null || { verdict=FAIL; reasons="$reasons failing counterexample has '$n_calls' calls (need >= 2 to observe order);"; }
[ "$all_hex" = true ] || { verdict=FAIL; reasons="$reasons not every call has hex calldata and a hex sender;"; }
[ "$order_ok" = true ] || { verdict=FAIL; reasons="$reasons call order is not arm before fire ($funcs);"; }
[ "$replayed" = yes ] || { verdict=FAIL; reasons="$reasons reused directory did not replay the cached failure (cache file: '$cache_file');"; }
if [ "$MODE" != native ]; then
  [ "$fail_shape_rc" -eq 0 ] || { verdict=FAIL; reasons="$reasons failing JSON shape differs from the native fixture;"; }
  [ "$pass_shape_rc" -eq 0 ] || { verdict=FAIL; reasons="$reasons passing JSON shape differs from the native fixture;"; }
fi
{ [ "$p_ce_type" = null ] && [ "$p_calls" = 0 ]; } || { verdict=FAIL; reasons="$reasons passing run counterexample type '$p_ce_type' with $p_calls calls;"; }

{
  echo "# 1.4 Risk 3: forge --json counterexample ($MODE)"
  echo
  echo "**$verdict**"
  echo
  echo "- forge: $(forge --version | head -1)"
  echo "- Fixture: invariant_witness fails only after arm(key%4==1) then fire(n%4==3); noise() is irrelevant. Default invariant config (runs, depth, shrink_run_limit untouched). Failing contract targets noise, arm, fire; passing contract omits fire."
  echo "- Exit codes: failing run $fail_rc, passing run $pass_rc. stdout is one JSON document: failing $fail_valid, passing $pass_valid (stderr kept separate; first stdout byte: '$stdout_head')."
  echo "- Top level: object keyed by \`<file>:<contract>\`; result at \`.[\"<file>:<contract>\"].test_results[\"invariant_witness()\"]\`."
  echo "- Failing: status=$f_status; \`counterexample\` type=$f_ce_type, keys=[$f_ce_keys]."
  echo "- Counterexample path: \`.counterexample.Sequence\` = \`[<original sequence length>, [<call>, ...]]\` (a 2-element array, not a bare list)."
  echo "- Original sequence length (Sequence[0], inferred meaning: pre-shrink length, since it is larger than the shrunk list): $orig_len; calls after shrinking (Sequence[1] length): $n_calls; shrinking reduced it: $shrunk."
  echo "- Per-call keys: [$call_keys]"
  echo "- Call order (func_name): $funcs; arm before fire: $order_ok; all calls have hex calldata and 20-byte sender: $all_hex."
  echo "- Seed: \`--fuzz-seed $SEED\` for both fixtures (override with SEED). Each forge run used a fresh scratch copy."
  echo "- Negative check (reusing a directory): cache/invariant file present: $([ -n "$cache_file" ] && echo yes || echo no); rerun in the same directory with seed $ALT_SEED returned the identical shrunk calls (the cached failure was replayed): $replayed. On replay \`reason\` changed from '$fresh_reason' to '$reuse_reason' and Sequence[0] changed from $orig_len to $reuse_orig_len, so a replay's Sequence[0] is the shrunk length, not the pre-shrink length; this is why every séance needs a fresh directory. A fresh directory with seed $ALT_SEED gave a different sequence: $alt_differs (informational)."
  echo "- Shape-only comparison with the native fixtures (keys, value types, structure of \`counterexample.Sequence[1]\`; shrunk sequences are not compared, forge 1.5.1 is not seed-reproducible, see 1.11). Part of the verdict in Docker mode: $cmp_result. The shrunk sequence of this run is saved to \`findings/1.4.$MODE.sequence.json\` for the record only."
  echo "- Calls:"
  echo '```'
  echo "$calls_table"
  echo '```'
  echo "- Passing: status=$p_status; \`counterexample\` type=$p_ce_type (JSON \`null\`, the key is present); calls in it: $p_calls."
  echo "- Fixtures written to engine/test/fixtures/forge-json/{failing,passing}.json: $saved (only the native run writes them)."
  echo "- Design comparison (design.md, Phase 2: \"the \`counterexample\` entry is a list of handler calls, each with the handler \`calldata\` (hex) and sender\"):"
  echo "  - Mismatch 1: \`counterexample\` is not a list. It is an object \`{\"Sequence\": [<originalLength:number>, [<call>...]]}\`; the call list is at \`.counterexample.Sequence[1]\`."
  echo "  - No mismatch in field names: \`sender\` and \`calldata\` match the design. Extra per-call fields: \`addr\` (handler address), \`contract_name\`, \`func_name\`, \`signature\`, \`args\` (display string), \`raw_args\` (comma-joined decimal string)."
  echo "  - Passing run: \`counterexample\` is \`null\` (present, not absent)."
  echo "  - \`parseCounterexample\` must read \`result.counterexample?.Sequence?.[1] ?? []\`, tolerate other enum variants (forge's \`CounterExample\` is an enum; only \`Sequence\` was observed), and must locate the result by iterating the dynamic top-level keys and \`test_results\`."
  if [ "$verdict" = FAIL ]; then
    echo "- Failure reasons:$reasons"
    echo "- Design change needed: rewrite the \`foundry-json.ts\` contract to the real shape above."
  else
    echo "- Design change needed: yes, wording only. Replace \"a list of handler calls\" with the real shape \`counterexample.Sequence[1]\` as listed above; the information the engine needs (ordered calls, hex calldata, sender) is all present."
  fi
} >"$FINDINGS_FILE"

cp "$FINDINGS_FILE" "$(dirname "$FINDINGS_FILE")/1.4.$MODE.md"
cat "$FINDINGS_FILE"
[ "$verdict" = PASS ]
