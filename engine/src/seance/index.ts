/**
 * Public API of the Séance_Engine package.
 *
 * `runSeance` is the Entry_Point (`runSeanceEntry` in entry.ts): `runSeance(input, opts)`.
 * The Runner's lower-level `runSeance(input, deps)` is exported as `runSeanceWithDeps`.
 */

export {
  ENV_FORGE_BIN,
  ENV_FORGE_STD_DIR,
  SeanceErrorException,
  defaultGraveyardRoot,
  isSeanceErrorException,
  resolveDeps,
  runSeanceEntry,
  runSeanceEntry as runSeance,
  runSeanceOrThrow,
  type SeanceOptions,
} from "./entry.js";
export { runSeance as runSeanceWithDeps, type RunnerDeps, type SeanceRunResult } from "./runner.js";
export { createProcessRunner, type ProcessRunner } from "./process-runner.js";
export { loadGraveyardInput } from "./graveyard.js";
export { runBecAcceptance, checkBecAcceptance } from "./acceptance.js";
export { validateInput } from "./inputs.js";
export { parseAutopsyReport, SUPPORTED_SCHEMA_VERSIONS } from "./autopsy-contract.js";
export { default as autopsySchema } from "./schemas/autopsy-v1.schema.json" with { type: "json" };
export { default as seanceReportSchema } from "./schemas/seance-report.schema.json" with { type: "json" };
export { listInstalledSolc } from "./bytecode.js";
export { validateReport, parseReport, serializeReport } from "./report.js";
export {
  CLASSIFICATIONS,
  SEANCE_ERROR_CODES,
  isSeanceErrorCode,
  type Classification,
  type Result,
  type SeanceError,
  type SeanceErrorCode,
  type SeanceInput,
  type SeanceReport,
} from "./types.js";
