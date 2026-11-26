/**
 * Entry_Point library layer (task 11.1).
 *
 * A thin public wrapper over the Runner's `runSeance(input, deps)` (runner.ts), which owns the
 * orchestration: validation, solc check, build, autopsy parse, targets, project generation,
 * discovery, witness, replay, report and the atomic report write. This module only fills in
 * defaults (graveyard root, tmp root, forge binary, forge-std directory, installed solc, real
 * process runner, clock), and guarantees that the Result variant never rejects: any unexpected
 * exception becomes a `SEANCE_FAILED` error.
 *
 * Errors are returned (`Result`), like the Runner. `runSeanceOrThrow` is the rejecting variant.
 * There is no AbortSignal support: `ProcessRunner` has no cancellation hook, so the shared
 * deadline (`timeoutSeconds`, default 300) is the only way to stop a run.
 */

import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listInstalledSolc } from "./bytecode.js";
import { FORGE_STD_DEFAULT_DIR } from "./forge-std-pin.js";
import { createProcessRunner, type ProcessRunner } from "./process-runner.js";
import { runSeance as runSeanceWithDeps, type RunnerDeps, type SeanceRunResult } from "./runner.js";
import { err, seanceError, type Result, type SeanceError } from "./types.js";

export type { SeanceRunResult } from "./runner.js";

/** Environment variable that overrides the forge-std checkout directory. */
export const ENV_FORGE_STD_DIR = "SEANCE_FORGE_STD_DIR";
/** Environment variable that overrides the forge executable. */
export const ENV_FORGE_BIN = "SEANCE_FORGE_BIN";

/** `<repo root>/graveyard`, derived from this file's location (`engine/src/seance/entry.ts`). */
export function defaultGraveyardRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../graveyard");
}

export interface SeanceOptions {
  /** Parent of `<name>/seance-report.json`. Default: `<repo root>/graveyard`. */
  graveyardRoot?: string;
  /** Directory name under `graveyardRoot`. Default: the contract name. */
  graveyardName?: string;
  /** Parent of the fresh per-séance project directories. Must exist. Default: `os.tmpdir()`. */
  tmpRoot?: string;
  /** forge-std checkout. Default: `SEANCE_FORGE_STD_DIR`, else `/opt/forge-std`. */
  forgeStdDir?: string;
  /** forge executable. Default: `SEANCE_FORGE_BIN`, else `forge`. */
  forgeBin?: string;
  /** Installed solc versions. Default: `listInstalledSolc()`. */
  solcInstalled?: RunnerDeps["solcInstalled"];
  /** Process runner. Default: `createProcessRunner()`. */
  runner?: ProcessRunner;
  /** Clock in ms. Default: `Date.now`. */
  now?: () => number;
  /** Environment used for the overrides above. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  keepTempOnFailure?: boolean;
  keepTempOnSuccess?: boolean;
  generatorOptions?: RunnerDeps["generatorOptions"];
}

/** An `Error` that carries the structured `SeanceError` (for `runSeanceOrThrow`). */
export class SeanceErrorException extends Error {
  readonly error: SeanceError;
  constructor(error: SeanceError) {
    super(`${error.code}: ${error.message}`);
    this.name = "SeanceErrorException";
    this.error = error;
  }
}

export function isSeanceErrorException(v: unknown): v is SeanceErrorException {
  return v instanceof SeanceErrorException;
}

const nonEmpty = (v: string | undefined): string | undefined => (v === undefined || v === "" ? undefined : v);

/** ASCII only, control characters removed, at most `max` characters. */
function sanitize(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const ascii = text.replace(/[^\x20-\x7e\n]/g, "?");
  return ascii.length > max ? `${ascii.slice(0, max)}...` : ascii;
}

function failureFrom(e: unknown): SeanceError {
  const message = e instanceof Error ? e.message : String(e);
  const stack = e instanceof Error && typeof e.stack === "string" ? e.stack.split("\n").slice(1, 6).join("\n") : "";
  return seanceError("SEANCE_FAILED", `unexpected failure: ${sanitize(message, 500)}`, {
    ...(stack !== "" && { stackHint: sanitize(stack, 600) }),
  });
}

/** Resolves the Runner's dependencies from the options, the environment and the defaults. */
export function resolveDeps(opts: SeanceOptions = {}): RunnerDeps {
  const env = opts.env ?? process.env;
  return {
    runner: opts.runner ?? createProcessRunner(),
    now: opts.now ?? Date.now,
    tmpRoot: opts.tmpRoot ?? tmpdir(),
    solcInstalled: opts.solcInstalled ?? (() => listInstalledSolc()),
    forgeStdDir: opts.forgeStdDir ?? nonEmpty(env[ENV_FORGE_STD_DIR]) ?? FORGE_STD_DEFAULT_DIR,
    forgeBin: opts.forgeBin ?? nonEmpty(env[ENV_FORGE_BIN]) ?? "forge",
    graveyardRoot: opts.graveyardRoot ?? defaultGraveyardRoot(),
    ...(opts.graveyardName !== undefined && { graveyardName: opts.graveyardName }),
    ...(opts.keepTempOnFailure !== undefined && { keepTempOnFailure: opts.keepTempOnFailure }),
    ...(opts.keepTempOnSuccess !== undefined && { keepTempOnSuccess: opts.keepTempOnSuccess }),
    ...(opts.generatorOptions !== undefined && { generatorOptions: opts.generatorOptions }),
  };
}

/**
 * Runs one séance and writes `<graveyardRoot>/<name>/seance-report.json`.
 *
 * Never throws and never rejects: every failure, including an unexpected exception from the
 * runner, the file system or JSON handling, is returned as an error (`SEANCE_FAILED` for the
 * unexpected ones). The timeout comes from `input.timeoutSeconds` (300 when absent).
 */
export async function runSeanceEntry(input: unknown, opts: SeanceOptions = {}): Promise<Result<SeanceRunResult>> {
  try {
    return await runSeanceWithDeps(input, resolveDeps(opts));
  } catch (e) {
    return err(failureFrom(e));
  }
}

/** Same as `runSeanceEntry`, but rejects with a `SeanceErrorException` on failure. */
export async function runSeanceOrThrow(input: unknown, opts: SeanceOptions = {}): Promise<SeanceRunResult> {
  const r = await runSeanceEntry(input, opts);
  if (!r.ok) throw new SeanceErrorException(r.error);
  return r.value;
}
