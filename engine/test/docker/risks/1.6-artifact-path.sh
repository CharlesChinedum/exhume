#!/usr/bin/env bash
# Task 1.6, Risk 5: artifact path layout and Metadata_Suffix strip for the bytecode check.
# Runs in a scratch copy of fixtures/token (see README). Exits non-zero on FAIL.
# Writes findings/1.6.$MODE.md only. Uses the foundry.toml scheme found in task 1.5.
set -uo pipefail
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/1.6-artifact-path"
: "${FINDINGS_FILE:?}"
: "${FORGE_STD_DIR:?}"
: "${MODE:?}"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
OUT_FILE="$(dirname "$FINDINGS_FILE")/1.6.$MODE.md"
LEG=out/LegacyToken.sol/Token.json
POR=out/PortToken.sol/Token.json
mkdir -p test seance-out
cp "$SRC_DIR/Code.t.sol" test/Code.t.sol
cat >foundry.toml <<EOT
[profile.default]
src = "src"
out = "out"
allow_paths = ["$FORGE_STD_DIR"]
fs_permissions = [{ access = "read", path = "./out" }, { access = "read-write", path = "./seance-out" }]
optimizer = false
optimizer_runs = 1
additional_compiler_profiles = [{ name = "legacy_opt", optimizer = true, optimizer_runs = 200 }]
compilation_restrictions = [
  { paths = "src/legacy/LegacyToken.sol", version = "=0.4.19", min_optimizer_runs = 200 },
  { paths = "src/port/PortToken.sol", version = "=0.8.28" },
]
EOT
rm -rf out cache
forge build >build.log 2>&1; build_rc=$?
forge test --match-contract CodeTest -vv >test.log 2>&1; test_rc=$?

# --- hex helpers (pure bash, no node) ---
norm() { local s="${1#0x}"; printf '%s' "$s" | tr 'A-F' 'a-f'; }
# suffix_len <hex>: CBOR length from the last 2 bytes (big-endian) + 2 = total suffix bytes; empty if invalid
suffix_len() {
  local h; h="$(norm "$1")"
  [ "${#h}" -ge 4 ] && [ $(( ${#h} % 2 )) -eq 0 ] || return 1
  local n=$((16#${h: -4})) total
  total=$((n + 2))
  [ $((total * 2)) -le "${#h}" ] || return 1
  echo "$total"
}
strip() { local h t; h="$(norm "$1")"; t="$(suffix_len "$h")" || return 1; printf '%s' "${h:0:$(( ${#h} - t * 2 ))}"; }
suffix() { local h t; h="$(norm "$1")"; t="$(suffix_len "$h")" || return 1; printf '%s' "${h: -$((t * 2))}"; }

art_leg="$(jq -r '.deployedBytecode.object // empty' "$LEG" 2>/dev/null)"
art_por="$(jq -r '.deployedBytecode.object // empty' "$POR" 2>/dev/null)"
rd() { tr -d '[:space:]' <"seance-out/$1" 2>/dev/null; }
dc_leg="$(rd legacy.deploycode.hex)"; raw_leg="$(rd legacy.rawcreate.hex)"; gd_leg="$(rd legacy.getdeployed.hex)"; dc_por="$(rd port.deploycode.hex)"

verdict=PASS; reasons=""
bad() { verdict=FAIL; reasons="$reasons $1;"; }
[ "$build_rc" -eq 0 ] || bad "forge build failed (build.log)"
[ -f "$LEG" ] || bad "out/LegacyToken.sol/Token.json does not exist"
[ -n "$art_leg" ] || bad "deployedBytecode.object not readable in $LEG"
[ "$test_rc" -eq 0 ] || bad "CodeTest failed (test.log)"
[ -n "$dc_leg" ] || bad "no deployed legacy code recorded"

s_art="$(strip "$art_leg" 2>/dev/null)"; s_dc="$(strip "$dc_leg" 2>/dev/null)"; s_raw="$(strip "$raw_leg" 2>/dev/null)"
[ -n "$s_art" ] && [ "$s_art" = "$s_dc" ] || bad "stripped artifact code != stripped vm.deployCode code"
[ -n "$s_art" ] && [ "$s_art" = "$(strip "$gd_leg" 2>/dev/null)" ] || bad "stripped artifact code != stripped vm.getDeployedCode"
[ -n "$s_art" ] && [ "$s_art" = "$s_raw" ] || bad "stripped artifact code != stripped raw-CREATE code"
unstrip_dc=differ; [ "$(norm "$art_leg")" = "$(norm "$dc_leg")" ] && unstrip_dc=SAME
unstrip_raw=differ; [ "$(norm "$art_leg")" = "$(norm "$raw_leg")" ] && unstrip_raw=SAME

# (a) suffix lengths
leg_total="$(suffix_len "$art_leg")"; por_total="$(suffix_len "$art_por")"
leg_suffix="$(suffix "$art_leg")"; por_suffix="$(suffix "$art_por")"
leg_len_field="${leg_suffix: -4}"; por_len_field="${por_suffix: -4}"
leg_prefix_ok=no; [[ "$leg_suffix" == a165627a7a72305820* ]] && leg_prefix_ok=yes
[ "$leg_total" = 43 ] && [ "$leg_prefix_ok" = yes ] && [ "$leg_len_field" = 0029 ] || bad "0.4.19 suffix is not the 43-byte bzzr0 form"
[ -n "$por_total" ] || bad "0.8.28 suffix not parseable"
por_ipfs=no; [[ "$por_suffix" == *6970667358* ]] && por_ipfs=yes   # "ipfs" key (64 69 70 66 73 -> 6970667358 is 'ipfsX')
por_solc=no; [[ "$por_suffix" == *736f6c63* ]] && por_solc=yes     # "solc" key

# (b) negative checks
body="$(strip "$art_leg")"; sfx="$(suffix "$art_leg")"
first="${body:0:2}"; flip=$([ "$first" = "60" ] && echo 61 || echo 60)
mut_body="${flip}${body:2}${sfx}"
neg_body=PASS_unexpected; [ "$(strip "$mut_body")" != "$s_art" ] && neg_body=fails_as_required
[ "$neg_body" = fails_as_required ] || bad "one-byte body change still passed the stripped comparison"
# different metadata hash: flip the first hash byte inside the suffix (bytes after the 9-byte header), same length
hash_off=$((9 * 2))
hb="${sfx:$hash_off:2}"; nhb=$([ "$hb" = "00" ] && echo 01 || echo 00)
mut_sfx="${sfx:0:$hash_off}${nhb}${sfx:$((hash_off + 2))}"
neg_sfx=fails_unexpected; [ "$(strip "${body}${mut_sfx}")" = "$s_art" ] && neg_sfx=passes_as_required
[ "$neg_sfx" = passes_as_required ] || bad "changed metadata hash broke the stripped comparison"
unstripped_mut_sfx=SAME; [ "${body}${mut_sfx}" != "$(norm "$art_leg")" ] && unstripped_mut_sfx=differ

# (c) artifact keys
keys_top="$(jq -r 'keys|join(",")' "$LEG" 2>/dev/null)"
keys_db="$(jq -r '.deployedBytecode|keys|join(",")' "$LEG" 2>/dev/null)"
keys_b="$(jq -r '.bytecode|keys|join(",")' "$LEG" 2>/dev/null)"
db_pref="$(jq -r '.deployedBytecode.object[0:2]' "$LEG" 2>/dev/null)"
b_pref="$(jq -r '.bytecode.object[0:2]' "$LEG" 2>/dev/null)"
db_len="$(( $(wc -c <<<"$(norm "$art_leg")") - 1 ))"; b_len="$(jq -r '.bytecode.object|length-2' "$LEG" 2>/dev/null)"
db_link="$(jq -c '.deployedBytecode.linkReferences' "$LEG" 2>/dev/null)"
db_imm="$(jq -c '.deployedBytecode.immutableReferences' "$LEG" 2>/dev/null)"
b_link="$(jq -c '.bytecode.linkReferences' "$LEG" 2>/dev/null)"
b_imm="$(jq -c '.bytecode.immutableReferences' "$LEG" 2>/dev/null)"
por_keys_db="$(jq -r '.deployedBytecode|keys|join(",")' "$POR" 2>/dev/null)"
por_imm="$(jq -c '.deployedBytecode.immutableReferences' "$POR" 2>/dev/null)"

{
  echo "# 1.6 Risk 5: artifact path layout for the bytecode check ($MODE)"
  echo
  echo "**$verdict**"
  echo
  echo "- forge: $(forge --version | head -1)"
  echo "- foundry.toml: the scheme from 1.5 (exact \`=0.4.19\` restriction with \`min_optimizer_runs = 200\` and \`additional_compiler_profiles\`, port via its own \`version = \"=0.8.28\"\` restriction, no top-level \`solc\`). \`forge build\` rc=$build_rc, \`forge test\` rc=$test_rc."
  echo "- Path: \`out/LegacyToken.sol/Token.json\` exists: $([ -f "$LEG" ] && echo yes || echo no). \`deployedBytecode.object\` readable: $([ -n "$art_leg" ] && echo yes || echo no) ($db_len hex chars after the prefix). Port \`out/PortToken.sol/Token.json\` exists: $([ -f "$POR" ] && echo yes || echo no)."
  echo "- PASS check: stripped artifact \`deployedBytecode.object\` vs stripped on-chain code, in three routes."
  echo
  echo "| on-chain route | stripped equal | unstripped equal |"
  echo "|---|---|---|"
  echo "| \`vm.deployCode(\"LegacyToken.sol:Token\")\` then \`.code\` | $([ "$s_art" = "$s_dc" ] && [ -n "$s_dc" ] && echo yes || echo NO) | $unstrip_dc |"
  echo "| \`vm.getDeployedCode(\"LegacyToken.sol:Token\")\` | $([ "$s_art" = "$(strip "$gd_leg" 2>/dev/null)" ] && [ -n "$s_art" ] && echo yes || echo NO) | $([ "$(norm "$art_leg")" = "$(norm "$gd_leg")" ] && echo SAME || echo differ) |"
  echo "| raw \`CREATE\` of \`vm.getCode\` creation bytecode (no deployCode) | $([ "$s_art" = "$s_raw" ] && [ -n "$s_raw" ] && echo yes || echo NO) | $unstrip_raw |"
  echo
  echo "  The artifact and the deployed code come from the same compile, so unstripped equality is expected and is reported above as observed. The strip is still needed for code from a different compile (the mainnet code in the real Runner)."
  echo "- (a) Suffix length. Rule: the last 2 bytes are the CBOR length, big-endian, and the length excludes those 2 bytes, so the suffix is length + 2 bytes."
  echo "  - solc 0.4.19 (legacy): last 2 bytes \`$leg_len_field\` = $((16#$leg_len_field)), total suffix $leg_total bytes; starts with \`a165627a7a72305820\` (bzzr0 Swarm hash): $leg_prefix_ok. Suffix: \`$leg_suffix\`."
  echo "  - solc 0.8.28 (port): last 2 bytes \`$por_len_field\` = $((16#$por_len_field)), total suffix $por_total bytes; contains the \`ipfs\` key: $por_ipfs, contains the \`solc\` key: $por_solc. Suffix: \`$por_suffix\`."
  echo "  - Deployed port code (\`vm.deployCode\`) has the same suffix length as the artifact: $([ "$(suffix_len "$dc_por")" = "$por_total" ] && echo yes || echo no). Deployed port code equals its artifact unstripped: $([ "$(norm "$dc_por")" = "$(norm "$art_por")" ] && echo SAME || echo differ)."
  echo "- (b) Negative checks on the legacy artifact code:"
  echo "  - One body byte changed (first opcode byte \`$first\` to \`$flip\`), suffix untouched: stripped comparison $neg_body."
  echo "  - Metadata hash byte changed (\`$hb\` to \`$nhb\`, body untouched): stripped comparison $neg_sfx; unstripped strings $unstripped_mut_sfx."
  echo "- (c) Artifact keys read from \`$LEG\`:"
  echo "  - top-level keys: \`$keys_top\`"
  echo "  - \`deployedBytecode\` keys: \`$keys_db\`; \`.object\` prefix \`$db_pref\` (0x-prefixed: $([ "$db_pref" = 0x ] && echo yes || echo no)). \`linkReferences\` = \`$db_link\`, \`immutableReferences\` = \`$db_imm\` ($([ "$db_imm" = null ] && echo "absent/null" || echo present))."
  echo "  - \`bytecode\` (creation) keys: \`$keys_b\`; \`.object\` prefix \`$b_pref\`, $b_len hex chars; \`linkReferences\` = \`$b_link\`, \`immutableReferences\` = \`$b_imm\`."
  echo "  - Port \`deployedBytecode\` keys: \`$por_keys_db\`; \`immutableReferences\` = \`$por_imm\`."
  echo "  - The Runner should read \`deployedBytecode.object\` (runtime code), not \`bytecode.object\` (creation code, differs from on-chain code by the constructor)."
  if [ "$verdict" = FAIL ]; then
    echo "- Failure reasons:$reasons"
    echo "- Artifact path/shape change needed: the Runner must read the path and keys that the observations above show (see failing rows). Update the artifact path in the design accordingly."
  else
    echo "- Artifact path/shape change needed: none. The Runner reads \`out/<File>.sol/<Contract>.json\` and the \`deployedBytecode.object\` field."
  fi
} >"$OUT_FILE"
cat "$OUT_FILE"
[ "$verdict" = PASS ]
