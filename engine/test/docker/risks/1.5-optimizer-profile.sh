#!/usr/bin/env bash
# Task 1.5, Risk 4: per-file legacy optimizer profile and vm.deployCode name resolution.
# Runs in a scratch copy of fixtures/token (see README). Exits non-zero on FAIL.
# The script rewrites foundry.toml itself (the fixture's copy is replaced) and re-appends allow_paths.
set -uo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/1.5-optimizer-profile"
: "${FINDINGS_FILE:?}"
: "${FORGE_STD_DIR:?}"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }

LEG=out/LegacyToken.sol/Token.json
POR=out/PortToken.sol/Token.json
mkdir -p test
cp "$SRC_DIR/Deploy.t.sol" test/Deploy.t.sol

# write_toml <default-profile extra lines> <extra restriction keys, legacy> <extra restriction keys, port>
write_toml() {
  cat >foundry.toml <<EOF
[profile.default]
src = "src"
out = "out"
allow_paths = ["$FORGE_STD_DIR"]
fs_permissions = [{ access = "read", path = "./out" }, { access = "read-write", path = "./seance-out" }]
optimizer = false
optimizer_runs = 1
$1
additional_compiler_profiles = [{ name = "legacy_opt", optimizer = true, optimizer_runs = 200 }]
compilation_restrictions = [
  { paths = "src/legacy/LegacyToken.sol", version = "=0.4.19"$2 },
  { paths = "src/port/PortToken.sol", version = "=0.8.28"$3 },
]
EOF
}

# variant <name> <legacy extra> <port extra>: clean build + deployCode test; sets V_* variables.
variant() {
  local n="$1"
  rm -rf out cache seance-out; mkdir -p seance-out
  write_toml "" "$2" "$3"
  cp foundry.toml "foundry.$n.toml"
  forge build >"build.$n.log" 2>&1; eval "${n}_build_rc=$?"
  eval "${n}_has_leg=no; ${n}_has_por=no"
  [ -f "$LEG" ] && eval "${n}_has_leg=yes"
  [ -f "$POR" ] && eval "${n}_has_por=yes"
  eval "${n}_leg_ver=\$(jq -r .metadata.compiler.version $LEG 2>/dev/null)"
  eval "${n}_leg_opt=\$(jq -c .metadata.settings.optimizer $LEG 2>/dev/null)"
  eval "${n}_por_ver=\$(jq -r .metadata.compiler.version $POR 2>/dev/null)"
  eval "${n}_por_opt=\$(jq -c .metadata.settings.optimizer $POR 2>/dev/null)"
  jq -r .deployedBytecode.object "$LEG" >"leg.$n.hex" 2>/dev/null
  jq -r .deployedBytecode.object "$POR" >"por.$n.hex" 2>/dev/null
  forge test --match-contract DeployCodeTest -vv >"test.$n.log" 2>&1; eval "${n}_test_rc=$?"
  eval "${n}_hashes=\$(cat seance-out/hashes.txt 2>/dev/null)"
}

variant OFF "" ""
variant ON ', min_optimizer_runs = 200' ""
variant BOTH ', min_optimizer_runs = 200' ', min_optimizer_runs = 200'

# Informational: a top-level `solc = "0.8.28"` (design.md describes the port as a top-level solc pin).
rm -rf out cache seance-out; mkdir -p seance-out
write_toml 'solc = "0.8.28"' ', min_optimizer_runs = 200' ""
forge build >build.TOPSOLC.log 2>&1; TOPSOLC_rc=$?
TOPSOLC_msg=$(grep -E 'Error|error' build.TOPSOLC.log | head -2 | tr '\n' ' ')

# Informational: the `settings`/`profile`/`optimizer` restriction keys (unknown keys are silently ignored?).
for key in 'settings = "legacy_opt"' 'profile = "legacy_opt"' 'optimizer = true'; do
  rm -rf out cache seance-out; mkdir -p seance-out
  write_toml "" ", $key" ""
  forge build >build.key.log 2>&1; rc=$?
  k="$(cut -d' ' -f1 <<<"$key")"
  printf '%s rc=%s legacy optimizer=%s\n' "$k" "$rc" "$(jq -c .metadata.settings.optimizer $LEG 2>/dev/null)" >>keys.txt
done

same() { [ -s "$1" ] && [ -s "$2" ] && cmp -s "$1" "$2"; }
h() { awk '{print $1}' <<<"$1"; }
p() { awk '{print $2}' <<<"$1"; }

leg_off_vs_on=differ; same leg.OFF.hex leg.ON.hex && leg_off_vs_on=SAME
leg_on_vs_both=differ; same leg.ON.hex leg.BOTH.hex && leg_on_vs_both=SAME
leg_vs_port_off=differ; same leg.OFF.hex por.OFF.hex && leg_vs_port_off=SAME
port_off_vs_on=differ; same por.OFF.hex por.ON.hex && port_off_vs_on=SAME
port_off_vs_both=differ; same por.OFF.hex por.BOTH.hex && port_off_vs_both=SAME
dc_leg_off_vs_on=differ; [ -n "$(h "$OFF_hashes")" ] && [ "$(h "$OFF_hashes")" = "$(h "$ON_hashes")" ] && dc_leg_off_vs_on=SAME
dc_leg_on_vs_both=differ; [ -n "$(h "$ON_hashes")" ] && [ "$(h "$ON_hashes")" = "$(h "$BOTH_hashes")" ] && dc_leg_on_vs_both=SAME
dc_leg_vs_port=differ; [ -n "$(h "$OFF_hashes")" ] && [ "$(h "$OFF_hashes")" = "$(p "$OFF_hashes")" ] && dc_leg_vs_port=SAME

verdict=PASS; reasons=""
bad() { verdict=FAIL; reasons="$reasons $1;"; }
for n in OFF ON BOTH; do
  eval "[ \"\$${n}_build_rc\" -eq 0 ]" || bad "$n: forge build failed"
  eval "[ \"\$${n}_has_leg\" = yes ] && [ \"\$${n}_has_por\" = yes ]" || bad "$n: build did not produce both out/LegacyToken.sol/Token.json and out/PortToken.sol/Token.json"
  eval "[ \"\$${n}_test_rc\" -eq 0 ]" || bad "$n: DeployCodeTest failed (see test.$n.log)"
  eval "case \"\$${n}_leg_ver\" in 0.4.19+*) ;; *) exit 1;; esac" || bad "$n: legacy compiler is not 0.4.19"
  eval "case \"\$${n}_por_ver\" in 0.8.28+*) ;; *) exit 1;; esac" || bad "$n: port compiler is not 0.8.28"
done
[ "$dc_leg_vs_port" = differ ] || bad "deployCode legacy and port runtime code are identical"
[ "$leg_off_vs_on" = differ ] || bad "legacy artifact runtime code did not change with the optimizer on"
[ "$dc_leg_off_vs_on" = differ ] || bad "deployCode legacy runtime code did not change with the optimizer on"
[ "$(jq -r .enabled <<<"$OFF_leg_opt" 2>/dev/null)" = false ] || bad "OFF: legacy metadata optimizer not disabled ($OFF_leg_opt)"
[ "$(jq -r '"\(.enabled) \(.runs)"' <<<"$ON_leg_opt" 2>/dev/null)" = "true 200" ] || bad "ON: legacy metadata optimizer is not enabled at runs 200 ($ON_leg_opt)"
[ "$(jq -r .enabled <<<"$ON_por_opt" 2>/dev/null)" = false ] || bad "ON: port picked up the legacy optimizer ($ON_por_opt)"
[ "$leg_on_vs_both" = SAME ] && [ "$dc_leg_on_vs_both" = SAME ] || bad "legacy bytecode changed when the port shared the legacy optimizer setting"

{
  echo "# 1.5 Risk 4: per-file legacy optimizer profile and vm.deployCode names ($MODE)"
  echo
  echo "**$verdict**"
  echo
  echo "- forge: $(forge --version | head -1)"
  echo "- Fixture: \`src/legacy/LegacyToken.sol\` (contract \`Token\`, solc =0.4.19) and \`src/port/PortToken.sol\` (contract \`Token\`, solc =0.8.28). Test \`DeployCodeTest\` calls \`deployCode(\"LegacyToken.sol:Token\")\` and \`deployCode(\"PortToken.sol:Token\")\`."
  echo "- Three builds, each in a clean \`out/\` and \`cache/\`: OFF (legacy optimizer off), ON (legacy restricted with \`min_optimizer_runs = 200\`, selecting the optimizer profile), BOTH (the port also restricted with \`min_optimizer_runs = 200\`)."
  echo
  echo "| build | forge build rc | both artifacts | legacy compiler | legacy optimizer | port compiler | port optimizer | DeployCodeTest rc |"
  echo "|---|---|---|---|---|---|---|---|"
  for n in OFF ON BOTH; do
    eval "echo \"| $n | \$${n}_build_rc | leg=\$${n}_has_leg por=\$${n}_has_por | \$${n}_leg_ver | \\\`\$${n}_leg_opt\\\` | \$${n}_por_ver | \\\`\$${n}_por_opt\\\` | \$${n}_test_rc |\""
  done
  echo
  echo "- PASS check, \`vm.deployCode\` names: legacy and port runtime code (keccak256 of \`.code\` of the deployed address) compare as: $dc_leg_vs_port in the OFF build (PASS needs differ). Legacy \`$(h "$OFF_hashes")\`, port \`$(p "$OFF_hashes")\`. Each deployment also equalled \`vm.getDeployedCode\` of its own named artifact (asserted in the test)."
  echo "- PASS check, optimizer effect: legacy runtime code OFF vs ON: artifact $leg_off_vs_on, deployCode hash $dc_leg_off_vs_on (PASS needs differ). OFF \`$(h "$OFF_hashes")\`, ON \`$(h "$ON_hashes")\`."
  echo "- (a) Per-file profile applied: legacy metadata in ON is \`$ON_leg_opt\` with compiler \`$ON_leg_ver\`; port metadata in ON is \`$ON_por_opt\` with compiler \`$ON_por_ver\`. In OFF the legacy metadata is \`$OFF_leg_opt\`. Read from \`out/LegacyToken.sol/Token.json\` at \`.metadata.settings.optimizer\` and \`.metadata.compiler.version\`. Note \`runs\` is reported even when \`enabled\` is false."
  echo "- (b) Port sharing the legacy optimizer setting (BOTH): port optimizer \`$BOTH_por_opt\`; legacy runtime code ON vs BOTH: artifact $leg_on_vs_both, deployCode hash $dc_leg_on_vs_both (PASS needs SAME). Port runtime OFF vs ON: $port_off_vs_on; OFF vs BOTH: $port_off_vs_both."
  echo "- Informational, restriction keys. The profile is selected by the optimizer-runs range keys, not by a name. Other keys tried, in the order tried (each gives the legacy optimizer metadata shown; \`enabled:false\` means the key had no effect):"
  echo '```'
  cat keys.txt
  echo '```'
  echo "- Informational, top-level \`solc = \"0.8.28\"\` together with the legacy restriction: forge build rc=$TOPSOLC_rc ${TOPSOLC_msg:+(\`$TOPSOLC_msg\`)}."
  echo "- (c) Working foundry.toml (the BOTH variant adds \`, min_optimizer_runs = 200\` to the port entry; ON as shown):"
  echo '```toml'
  cat foundry.ON.toml
  echo '```'
  echo "  The default profile carries \`optimizer = false\` and \`optimizer_runs = 1\` so that the legacy-off artifact and the default settings differ in \`runs\` from the optimizer profile, and \`min_optimizer_runs = 200\` is satisfied only by the \`legacy_opt\` additional profile."
  if [ "$verdict" = FAIL ]; then
    echo "- Failure reasons:$reasons"
    echo "- Design change needed: decision 9 and the \`foundry.toml\` section must switch to the scheme that the table above shows working (see the rows that failed)."
  else
    echo "- Design change needed: yes, foundry.toml section only. Do not use a top-level \`solc\` pin (see the informational line); pin the port with \`version = \"=0.8.28\"\` in its own \`compilation_restrictions\` entry. Select the legacy optimizer profile with \`min_optimizer_runs = 200\` in the legacy entry plus \`additional_compiler_profiles = [{ name = \"legacy_opt\", optimizer = true, optimizer_runs = 200 }]\`. The default profile must set \`optimizer = false\` and \`optimizer_runs = 1\`. Decision 9 (artifact names) holds unchanged."
  fi
} >"$FINDINGS_FILE"

cp "$FINDINGS_FILE" "$(dirname "$FINDINGS_FILE")/1.5.$MODE.md"
cat "$FINDINGS_FILE"
[ "$verdict" = PASS ]
