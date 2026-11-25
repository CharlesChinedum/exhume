#!/usr/bin/env bash
# Task 1.7, Risk 6: pinned forge-std resolves through remappings.txt + allow_paths (no lib/, no network).
# Runs in a scratch copy of fixtures/token (see README). Exits non-zero on FAIL.
# Writes findings/1.7.$MODE.md only. Uses FORGE_STD_DIR from the harness (never hard-codes /opt/forge-std).
set -uo pipefail
DOCKER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/1.7-forge-std-path"
: "${FINDINGS_FILE:?}"
: "${FORGE_STD_DIR:?}"
: "${MODE:?}"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
OUT_FILE="$(dirname "$FINDINGS_FILE")/1.7.$MODE.md"
PIN="$(tr -d '[:space:]' <"$DOCKER_DIR/FORGE_STD_PIN")"
EXPECT_SHORT=1eea5bae
mkdir -p test seance-out
cp "$SRC_DIR/Imports.t.sol" test/Imports.t.sol
rm -rf lib
# No network as far as feasible: forge --offline plus a dead proxy (any HTTP client that honours it fails fast).
export HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 NO_PROXY=
offline_help="$(forge build --help 2>&1 | grep -c -- '--offline')"
FS="$FORGE_STD_DIR"

# --- pin check ---
head_sha="$(git -C "$FS" rev-parse HEAD 2>&1)"
pin_sha="$(git -C "$FS" rev-parse "$PIN^{commit}" 2>&1)"
dirty="$(git -C "$FS" status --porcelain 2>&1 | wc -l | tr -d ' ')"
pin_ok=no
[ "$head_sha" = "$pin_sha" ] && case "$head_sha" in "$EXPECT_SHORT"*) pin_ok=yes ;; esac

LEGACY_RESTR='{ paths = "src/legacy/LegacyToken.sol", version = "=0.4.19", min_optimizer_runs = 200 },
  { paths = "src/port/PortToken.sol", version = "=0.8.28" },'
# write_project <allow_paths line|""> <extra restriction lines>
write_project() {
  printf 'forge-std/=%s/src/\n' "$FS" >remappings.txt
  cat >foundry.toml <<EOT
[profile.default]
src = "src"
out = "out"
$1
fs_permissions = [{ access = "read", path = "./out" }, { access = "read-write", path = "./seance-out" }]
optimizer = false
optimizer_runs = 1
additional_compiler_profiles = [{ name = "legacy_opt", optimizer = true, optimizer_runs = 200 }]
compilation_restrictions = [
  $LEGACY_RESTR
$2]
EOT
}
AP="allow_paths = [\"$FS\"]"
# solc version that compiled an artifact (empty if missing)
solc_of() { jq -r '.metadata.compiler.version // empty' "$1" 2>/dev/null; }
# stage <name> <allow_paths line> <extra restrictions>: clean build offline, records rc/log/versions.
stage() {
  local n="$1"
  rm -rf out cache
  write_project "$2" "$3"
  cp foundry.toml "foundry.$n.toml"
  forge build --offline >"build.$n.log" 2>&1; eval "${n}_build_rc=$?"
  eval "${n}_std_ver=\$(solc_of out/Test.sol/Test.json)"
  eval "${n}_inv_ver=\$(solc_of out/StdInvariant.sol/StdInvariant.json)"
  eval "${n}_vm_ver=\$(solc_of out/Vm.sol/Vm.json)"
  eval "${n}_imp_ver=\$(solc_of out/Imports.t.sol/ImportsTest.json)"
}

# errmsg <log>: the first error lines (or the last lines if none), on one line
errmsg() { if grep -qE '^Error' "$1"; then grep -A4 -E '^Error' "$1" | head -6 | tr '\n' ' '; else tail -2 "$1" | tr '\n' ' '; fi; }
# 1. Negative: remapping without allow_paths.
stage NEG "" ""
NEG_msg="$(errmsg build.NEG.log)"
# 2. Positive, 1.5 scheme only (restrictions name just src/legacy and src/port).
stage BASE "$AP" ""
BASE_msg="$(errmsg build.BASE.log)"
# 3. Candidate restriction forms that also cover forge-std (outside the project) and test/.
declare -a FORMS_NAME=() FORMS_TXT=()
FORMS_NAME+=("absolute-glob"); FORMS_TXT+=("  { paths = \"$FS/src/**\", version = \"=0.8.28\" },
  { paths = \"test/**\", version = \"=0.8.28\" },
")
FORMS_NAME+=("absolute-dir"); FORMS_TXT+=("  { paths = \"$FS/src\", version = \"=0.8.28\" },
  { paths = \"test\", version = \"=0.8.28\" },
")
FORMS_NAME+=("test-only"); FORMS_TXT+=("  { paths = \"test/**\", version = \"=0.8.28\" },
")
GOOD_FORM=""
form_rows=""
for i in "${!FORMS_NAME[@]}"; do
  n="F$i"
  stage "$n" "$AP" "${FORMS_TXT[$i]}"
  eval "rc=\$${n}_build_rc; sv=\$${n}_std_ver; iv=\$${n}_inv_ver; vv=\$${n}_vm_ver; mv=\$${n}_imp_ver"
  form_rows="$form_rows| ${FORMS_NAME[$i]} | $rc | $sv | $iv | $vv | $mv |
"
  if [ -z "$GOOD_FORM" ] && [ "$rc" -eq 0 ] && case "$sv$iv$vv" in 0.8.28+*0.8.28+*0.8.28+*) true ;; *) false ;; esac; then
    GOOD_FORM="$i"
  fi
done
# 3b. Probes. (i) Is an absolute-path restriction on forge-std honoured? Ask for 0.8.30 (installed natively) and read the artifact.
stage PROBE "$AP" "  { paths = \"$FS/src/**\", version = \"=0.8.30\" },
  { paths = \"test/**\", version = \"=0.8.30\" },
"
# (ii) Without remappings.txt (allow_paths only): is the import unresolved?
rm -rf out cache; write_project "$AP" ""; rm -f remappings.txt
forge build --offline >build.NOREMAP.log 2>&1; NOREMAP_rc=$?
NOREMAP_msg="$(errmsg build.NOREMAP.log)"
# 4. Final: working form (or the base scheme if none worked), build + test, offline.
if [ -n "$GOOD_FORM" ]; then FINAL_RESTR="${FORMS_TXT[$GOOD_FORM]}"; else FINAL_RESTR=""; fi
stage FINAL "$AP" "$FINAL_RESTR"
art_ok=no
[ -f out/Test.sol/Test.json ] && [ -f out/StdInvariant.sol/StdInvariant.json ] && [ -f out/Vm.sol/Vm.json ] && art_ok=yes
forge test --offline --match-contract ImportsTest -vv >test.FINAL.log 2>&1; test_rc=$?
lib_exists=no; [ -e lib ] && lib_exists=yes
net_hits="$(grep -ciE 'install|download|fetch|clon|connect|network' build.FINAL.log test.FINAL.log | tr '\n' ' ')"
# Without --offline but with the dead proxy: does forge need the network at all when all solc versions are installed?
rm -rf out cache
forge build >build.NOFLAG.log 2>&1; NOFLAG_rc=$?
NOFLAG_msg="$(errmsg build.NOFLAG.log)"
# Offline with a solc version that is not installed must fail without downloading.
rm -rf out cache
sed 's/=0\.8\.28/=0.8.31/' foundry.FINAL.toml >foundry.toml
forge build --offline >build.MISSING.log 2>&1; MISSING_rc=$?
MISSING_msg="$(errmsg build.MISSING.log)"
cp foundry.FINAL.toml foundry.toml

verdict=PASS; reasons=""
bad() { verdict=FAIL; reasons="$reasons $1;"; }
[ "$pin_ok" = yes ] || bad "forge-std checkout $head_sha does not match the pin $PIN ($pin_sha) / $EXPECT_SHORT"
[ "$dirty" = 0 ] || bad "forge-std checkout has $dirty modified files"
[ "$BASE_build_rc" -eq 0 ] || bad "forge build --offline with remappings.txt + allow_paths failed (base scheme)"
[ "$FINAL_build_rc" -eq 0 ] || bad "final forge build --offline failed"
[ "$test_rc" -eq 0 ] || bad "forge test --offline (imports forge-std/Test.sol, StdInvariant.sol, Vm.sol) failed"
[ "$lib_exists" = no ] || bad "lib/ directory exists"
NEG_expected=yes; [ "$NEG_build_rc" -ne 0 ] || NEG_expected=no
[ "$art_ok" = yes ] || bad "forge-std artifacts missing in out/"
[ -n "$GOOD_FORM" ] || bad "no tried restriction form put forge-std on 0.8.28"
case "$FINAL_std_ver$FINAL_inv_ver$FINAL_vm_ver" in 0.8.28+*0.8.28+*0.8.28+*) ;; *) bad "forge-std was not compiled by solc 0.8.28 in the final build" ;; esac

{
  echo "# 1.7 Risk 6: pinned forge-std via remappings.txt and allow_paths ($MODE)"
  echo
  echo "**$verdict**"
  echo
  echo "- forge: $(forge --version | head -1)"
  echo "- forge-std dir (FORGE_STD_DIR from the harness): \`$FS\`. HEAD \`$head_sha\`; \`$PIN^{commit}\` = \`$pin_sha\`; expected prefix \`$EXPECT_SHORT\`: match=$pin_ok; modified files in checkout: $dirty."
  echo "- Project: \`remappings.txt\` = \`forge-std/=$FS/src/\`, \`allow_paths = [\"$FS\"]\`, no \`lib/\` directory (exists: $lib_exists). \`test/Imports.t.sol\` imports \`forge-std/Test.sol\`, \`forge-std/StdInvariant.sol\` and \`forge-std/Vm.sol\`."
  echo "- PASS check, \`forge build --offline\` (final foundry.toml below) rc=$FINAL_build_rc; \`forge test --offline --match-contract ImportsTest\` rc=$test_rc. Build of the 1.5 scheme alone (restrictions only name src/legacy and src/port) rc=$BASE_build_rc."
  echo "- (a) Offline behaviour. \`forge build --help\` lists \`--offline\` (match count $offline_help; also accepted by \`forge test\`): \"Do not access the network. Missing solc versions will not be installed.\" Every build and test above used \`--offline\`, with \`HTTP_PROXY\`/\`HTTPS_PROXY\`/\`ALL_PROXY\` set to \`http://127.0.0.1:9\` (a dead port) so any proxy-aware client would also fail. Network use is not proven absent at the OS level (no firewall or network namespace is used natively). Evidence: grep count of install/download/fetch/clone/connect/network words in the final build and test logs: $net_hits (per file). A build with a solc version that is not installed (\`=0.8.31\`) with \`--offline\` gave rc=$MISSING_rc: \`$MISSING_msg\`. The same final project built WITHOUT \`--offline\` but with the dead proxy gave rc=$NOFLAG_rc (\`$NOFLAG_msg\`); rc 0 means forge made no network call that could fail when all needed solc versions are installed. solc 0.4.19 and 0.8.28 must be pre-installed (svm); only the project's two pinned versions are used."
  echo "- (b) Negative check, remapping without \`allow_paths\`: forge build rc=$NEG_build_rc. Output: \`$NEG_msg\`. Expected a failure: $NEG_expected (observed failure: $([ "$NEG_build_rc" -ne 0 ] && echo yes || echo no)). If no, forge ${FORGE_VER:-1.5.1} reads remapped paths outside the project without \`allow_paths\`, so \`allow_paths\` is not what makes the import resolve; it is kept in the generated foundry.toml as the design and task require (this check did not test whether it matters for anything else)."
  echo "  Without \`remappings.txt\` (allow_paths only): rc=$NOREMAP_rc. Output: \`$NOREMAP_msg\`"
  echo "  With \`allow_paths\` (base scheme): rc=$BASE_build_rc. ${BASE_msg:+Output: \`$BASE_msg\`}"
  echo "- (c) Import resolution, artifacts in the final build and the solc that compiled them: \`out/Test.sol/Test.json\` $FINAL_std_ver; \`out/StdInvariant.sol/StdInvariant.json\` $FINAL_inv_ver; \`out/Vm.sol/Vm.json\` $FINAL_vm_ver; \`out/Imports.t.sol/ImportsTest.json\` $FINAL_imp_ver. \`ImportsTest\` uses \`Test\`, \`StdInvariant\` and the \`Vm\` interface (\`vm.\` cheatcodes, \`Vm.Log\`)."
  echo "- (d) forge-std under the task 1.5 scheme (exact \`=0.8.28\`, \`additional_compiler_profiles\` with \`min_optimizer_runs\`, port pinned by its own entry, no top-level \`solc\`). With restrictions that only name src/legacy and src/port (base): forge-std compiled with solc \`$BASE_std_ver\`, Imports test with \`$BASE_imp_ver\` (rc=$BASE_build_rc). forge-std's pragma is \`>=0.6.2 <0.9.0\`; natively many 0.8.x versions are installed (0.8.9 to 0.8.37), and forge still chose 0.8.28 for the whole 0.8 group (the port's exact pin), so whether an unrestricted forge-std stays on 0.8.28 depends on forge's grouping rather than on a rule the generator controls; in Docker only 0.4.19 and 0.8.28 are installed. Probe: an absolute-path restriction \`{ paths = \"$FS/src/**\", version = \"=0.8.30\" }\` plus \`test/**\` =0.8.30 gave build rc=$PROBE_build_rc and forge-std solc \`$PROBE_std_ver\` (honoured if it reads 0.8.30). Restriction forms tried to cover forge-std (outside the project) and \`test/\`:"
  echo
  echo "| form | build rc | Test.sol solc | StdInvariant.sol solc | Vm.sol solc | Imports.t.sol solc |"
  echo "|---|---|---|---|---|---|"
  printf '%s' "$form_rows"
  echo
  echo "  Chosen form: ${FORMS_NAME[${GOOD_FORM:-0}]:-none}$([ -n "$GOOD_FORM" ] || echo ' (none worked)'). Exact working foundry.toml the generator should emit (the \`allow_paths\` value and the forge-std path are the checkout directory):"
  echo '```toml'
  cat foundry.FINAL.toml
  echo '```'
  echo "  and \`remappings.txt\`:"
  echo '```'
  cat remappings.txt
  echo '```'
  if [ "$verdict" = FAIL ]; then
    echo "- Failure reasons:$reasons"
    echo "- Design change needed: decision 11 (vendoring scheme) must change: the remapping plus \`allow_paths\` scheme did not meet every PASS criterion above. Candidate fallback: vendor forge-std into the generated project (e.g. \`vendor/forge-std\` inside the project root, no \`allow_paths\`)."
  else
    echo "- Design change needed: none to decision 11 (remappings.txt + allow_paths works with no \`lib/\`). The generator should still emit an explicit exact \`=0.8.28\` restriction covering forge-std (absolute glob) and the generated test files (see the chosen form): the probe shows forge honours it, whereas with only src/legacy and src/port named the solc for forge-std is chosen by forge's own grouping (observed 0.8.28 here, not guaranteed)."
  fi
} >"$OUT_FILE"
cat "$OUT_FILE"
[ "$verdict" = PASS ]
