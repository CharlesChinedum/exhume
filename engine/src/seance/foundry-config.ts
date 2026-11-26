/**
 * Renders the séance project's `foundry.toml` (design: Project_Generator,
 * decisions 11 and 12, Property 2). Pure and deterministic: fixed key order,
 * LF newlines, trailing newline, no clocks or environment reads.
 *
 * Scheme verified on forge 1.5.1 by tasks 1.5 and 1.7: no top-level `solc`,
 * every restriction pinned with an exact `=version`, the legacy optimizer
 * selected through `additional_compiler_profiles` plus
 * `min_optimizer_runs = max_optimizer_runs = R`
 * (never `profile`, `settings` or `optimizer` keys in a restriction).
 */
import {
  FORGE_STD_DEFAULT_DIR,
  INVARIANT_DEPTH,
  INVARIANT_RUNS,
  PORT_SOLC_VERSION,
  allowPathsToml,
  assertForgeStdDir,
} from "./forge-std-pin.js";
import { err, ok, seanceError, type Result } from "./types.js";

export interface FoundryConfigOptions {
  /** Contract name `<Name>`; must be a Solidity identifier. */
  contractName: string;
  /** Legacy solc version `0.x.y`; the restriction is written as `=<version>`. */
  legacySolcVersion: string;
  /** Legacy optimizer setting; `runs` is required when enabled (0..4294967295). */
  legacyOptimizer: { enabled: boolean; runs?: number };
  /** `<FORGE_STD_DIR>`, default `/opt/forge-std`. */
  forgeStdDir?: string;
  /** Adds the same `min_optimizer_runs = max_optimizer_runs = R` to the port restriction (only when the optimizer is enabled). */
  portSharesLegacyOptimizer?: boolean;
}

/** Gas limit that two capped 10,000,000-gas calls plus handler work never hit. */
export const GAS_LIMIT = 1_000_000_000;
/** Name of the additional compiler profile for the legacy optimizer. */
export const LEGACY_PROFILE_NAME = "legacy_opt";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SOLC_VERSION = /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_RUNS = 4294967295;

/** Default profile `optimizer_runs`: 1, or 2 when it would equal the legacy runs R. */
export function defaultOptimizerRuns(legacyRuns: number | undefined): number {
  return legacyRuns === 1 ? 2 : 1;
}

function invalid(message: string): Result<string> {
  return err(seanceError("INVALID_INPUT", message));
}

export function renderFoundryToml(opts: FoundryConfigOptions): Result<string> {
  const { contractName, legacySolcVersion } = opts;
  const forgeStdDir = opts.forgeStdDir ?? FORGE_STD_DEFAULT_DIR;
  if (typeof contractName !== "string" || !IDENT.test(contractName)) {
    return invalid(`contractName must match [A-Za-z_][A-Za-z0-9_]*: ${JSON.stringify(contractName)}`);
  }
  if (typeof legacySolcVersion !== "string" || !SOLC_VERSION.test(legacySolcVersion)) {
    return invalid(`legacySolcVersion must have the shape 0.x.y: ${JSON.stringify(legacySolcVersion)}`);
  }
  try {
    assertForgeStdDir(forgeStdDir);
  } catch (e) {
    return invalid((e as Error).message);
  }
  const enabled = opts.legacyOptimizer.enabled;
  let runs: number | undefined;
  if (enabled) {
    runs = opts.legacyOptimizer.runs;
    if (typeof runs !== "number" || !Number.isInteger(runs) || runs < 0 || runs > MAX_RUNS) {
      return invalid(`legacyOptimizer.runs must be an integer in 0..${MAX_RUNS} when the optimizer is enabled`);
    }
  }

  // Both bounds are always emitted together. With only `min_optimizer_runs = 0`
  // the default profile (optimizer = false, optimizer_runs = 1) also satisfies
  // the restriction and forge picks it (seen on forge 1.5.1 with R = 0).
  const minRuns = enabled ? `, min_optimizer_runs = ${runs}, max_optimizer_runs = ${runs}` : "";
  const portMinRuns = enabled && opts.portSharesLegacyOptimizer === true ? minRuns : "";
  const lines: string[] = [
    "[profile.default]",
    'src = "src"',
    'out = "out"',
    allowPathsToml(forgeStdDir),
    'fs_permissions = [{ access = "read", path = "./out" }, { access = "read-write", path = "./seance-out" }]',
    `gas_limit = ${GAS_LIMIT}`,
    "optimizer = false",
    `optimizer_runs = ${defaultOptimizerRuns(runs)}`,
  ];
  if (enabled) {
    lines.push(
      `additional_compiler_profiles = [{ name = "${LEGACY_PROFILE_NAME}", optimizer = true, optimizer_runs = ${runs} }]`,
    );
  }
  lines.push(
    "compilation_restrictions = [",
    `  { paths = "src/legacy/Legacy${contractName}.sol", version = "=${legacySolcVersion}"${minRuns} },`,
    `  { paths = "src/port/Port${contractName}.sol", version = "=${PORT_SOLC_VERSION}"${portMinRuns} },`,
    `  { paths = "${forgeStdDir}/src/**", version = "=${PORT_SOLC_VERSION}" },`,
    `  { paths = "test/**", version = "=${PORT_SOLC_VERSION}" },`,
    "]",
    "",
    "[profile.default.invariant]",
    `runs = ${INVARIANT_RUNS}`,
    `depth = ${INVARIANT_DEPTH}`,
    "fail_on_revert = true",
    "shrink_run_limit = 0",
  );
  return ok(lines.join("\n") + "\n");
}
