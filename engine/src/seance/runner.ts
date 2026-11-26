/**
 * Runner: shared deadline arithmetic, forge argument construction (task 10.1) and the run
 * orchestration (task 10.4, `runSeance` at the end of this file).
 *
 * The deadline and argument functions are pure. The orchestration spawns processes only through
 * the injected `ProcessRunner`, and reads the clock only through `deps.now`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { compareAbis, readPortArtifact } from "./abi-compat.js";
import { parseAutopsyReport } from "./autopsy-contract.js";
import { checkSolcPresent, compareRuntimeCode, readLegacyArtifact } from "./bytecode.js";
import { parseCounterexample, testStatus, type HandlerCall } from "./foundry-json.js";
import {
  FORGE_STD_DEFAULT_DIR,
  INVARIANT_RUNS,
  SHRINK_RUN_LIMIT_ENV,
  WITNESS_SHRINK_RUN_LIMIT,
} from "./forge-std-pin.js";
import { generateTargets } from "./input-generator.js";
import { validateInput } from "./inputs.js";
import type { ProcessResult, ProcessRunner } from "./process-runner.js";
import {
  computeSkippedFunctions,
  generateSrcProject,
  generateTestProject,
  regenerateReplay,
  regenerateWitness,
  writeProjectFiles,
  type GeneratorOptions,
  type ProjectFiles,
  type ShrunkSequence,
} from "./project-generator.js";
import {
  assignDispositions,
  buildReport,
  emptyCounts,
  pairKey,
  parseRecords,
  selectFindingPairs,
  validateReport,
  writeReportAtomic,
  type Pair,
  type PairProgress,
  type ShrinkOutcome,
} from "./report.js";
import { verifyTaint } from "./taint.js";
import {
  CLASSIFICATIONS,
  err,
  handlerFaultError,
  isClassification,
  ok,
  seanceError,
  timeoutError,
  type ClassificationCounts,
  type RecordLine,
  type Result,
  type SeanceError,
  type SeanceInput,
  type SeanceReport,
} from "./types.js";

export type { ProcessResult, ProcessRunner, ProcessRunOptions } from "./process-runner.js";
export { createProcessRunner, KILL_GRACE_MS } from "./process-runner.js";

// ---------------------------------------------------------------------------
// Deadline
// ---------------------------------------------------------------------------

/** One absolute deadline, shared by `forge build`, discovery, every witness and every replay run. */
export interface Deadline {
  readonly at: number; // absolute ms timestamp
}

/** Creates the run's single deadline: `startMs + timeoutSeconds * 1000`. */
export function makeDeadline(startMs: number, timeoutSeconds: number): Deadline {
  return { at: startMs + timeoutSeconds * 1000 };
}

/** Milliseconds left before the deadline; never negative. */
export function remainingMs(d: Deadline, nowMs: number): number {
  return Math.max(0, d.at - nowMs);
}

/**
 * Process timeout for the next forge run (build, discovery, witness or replay).
 *
 * Every phase receives the time remaining before the one shared deadline, not a fixed
 * slice, so time spent in `forge build` reduces what discovery receives. It is 0 once
 * the deadline has been reached.
 */
export function phaseBudgetMs(d: Deadline, nowMs: number): number {
  return remainingMs(d, nowMs);
}

/** True at exactly the deadline and after it (the budget is 0). */
export function isExpired(d: Deadline, nowMs: number): boolean {
  return phaseBudgetMs(d, nowMs) === 0;
}

// ---------------------------------------------------------------------------
// forge arguments
// ---------------------------------------------------------------------------

/** Largest witness / replay index (the witness cap). */
export const MAX_PAIR_INDEX = 10;

export type Phase =
  | { kind: "build" }
  | { kind: "discovery" }
  | { kind: "witness"; k: number }
  | { kind: "replay"; k: number };

export interface ForgeOpts {
  /** Passed to `--fuzz-seed` exactly as given (no trimming, parsing or conversion). Omitted flag when undefined. */
  fuzzSeed?: string;
}

export interface ForgeInvocation {
  args: string[];
  /** Variables to add to the process environment (not the full environment). */
  env: Record<string, string>;
}

/**
 * Builds the forge arguments and the extra environment for a phase.
 *
 * Arguments are an array handed to `spawn` without a shell, so the anchored regexes
 * (`^...$`) are single elements and need no quoting. The working directory is the
 * project directory and is set by the caller, so it is not part of the arguments.
 * `--offline` is passed everywhere: the generated project needs no network, and a
 * download attempt would burn the shared deadline.
 *
 * Discovery and replay run with recording on (`SEANCE_RECORD=1`); witness runs turn
 * it off and re-enable shrinking through `FOUNDRY_INVARIANT_SHRINK_RUN_LIMIT=5000`.
 * Returns INVALID_INPUT when `k` is not an integer in 1..10.
 */
export function buildForgeArgs(phase: Phase, opts: ForgeOpts = {}): Result<ForgeInvocation> {
  const seed = opts.fuzzSeed === undefined ? [] : ["--fuzz-seed", opts.fuzzSeed];
  switch (phase.kind) {
    case "build":
      return ok({ args: ["build", "--offline"], env: {} });
    case "discovery":
      return ok({
        args: [
          "test",
          "--offline",
          "--json",
          "--match-contract",
          "^SeanceDiscovery$",
          "--match-test",
          "invariant_discovery",
          ...seed,
        ],
        env: { SEANCE_RECORD: "1" },
      });
    case "witness": {
      const bad = checkIndex(phase.k);
      if (bad) return err(bad);
      return ok({
        args: [
          "test",
          "--offline",
          "--json",
          "--match-contract",
          `^Witness${phase.k}$`,
          "--match-test",
          "invariant_witness",
          ...seed,
        ],
        env: { SEANCE_RECORD: "0", [SHRINK_RUN_LIMIT_ENV]: String(WITNESS_SHRINK_RUN_LIMIT) },
      });
    }
    case "replay": {
      const bad = checkIndex(phase.k);
      if (bad) return err(bad);
      return ok({
        args: ["test", "--offline", "--json", "--match-contract", `^SeanceReplay${phase.k}$`, ...seed],
        env: { SEANCE_RECORD: "1" },
      });
    }
  }
}

function checkIndex(k: unknown) {
  if (typeof k === "number" && Number.isInteger(k) && k >= 1 && k <= MAX_PAIR_INDEX) return undefined;
  return seanceError("INVALID_INPUT", `witness/replay index must be an integer in 1..${MAX_PAIR_INDEX}: ${String(k)}`);
}

// ===========================================================================
// Run orchestration (task 10.4)
// ===========================================================================

export interface RunnerDeps {
  /** Spawns forge. `createProcessRunner()` in production, a script in tests. */
  runner: ProcessRunner;
  /** Clock in ms. The only time source; the shared deadline is computed from it. */
  now: () => number;
  /** Parent directory of the fresh per-séance project directories. Must exist. */
  tmpRoot: string;
  /** Installed solc versions (list or provider). Default: scan the svm directories. */
  solcInstalled?: string[] | (() => string[] | Promise<string[]>);
  /** `<FORGE_STD_DIR>` written into the generated project. Default `/opt/forge-std`. */
  forgeStdDir?: string;
  /** When given, the report is written to `<graveyardRoot>/<graveyardName>/seance-report.json`. Otherwise it is only returned. */
  graveyardRoot?: string;
  /** Directory name under `graveyardRoot`. Default: the contract name. */
  graveyardName?: string;
  /** Keep the temp project after a failed run (default true; the design keeps it for diagnosis). */
  keepTempOnFailure?: boolean;
  /** Keep the temp project after a successful run (default false; for debugging and tests). */
  keepTempOnSuccess?: boolean;
  /** forge executable (default `forge`). */
  forgeBin?: string;
  /** Extra generator options (for example `fundingWei`). `forgeStdDir` is taken from `forgeStdDir` above. */
  generatorOptions?: Omit<GeneratorOptions, "forgeStdDir" | "witnessPairs">;
}

export interface SeanceRunResult {
  report: SeanceReport;
  /** Present when the report was written to the graveyard. */
  reportPath?: string;
  /** Present only when the temp project was kept on success (`keepTempOnSuccess`). */
  tempDir?: string;
}

export const RECORDS_FILE = "seance-out/records.jsonl";
export const replayRecordsFile = (k: number): string => `seance-out/replay-${k}.jsonl`;

// --- small helpers ---------------------------------------------------------

function readOptional(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Parses the JSON object `forge test --json` prints. Tolerates log lines around it. */
export function parseForgeJson(stdout: string): unknown {
  const text = stdout.trim();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // fall through: look for a single JSON line
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trim();
    if (!l.startsWith("{")) continue;
    try {
      return JSON.parse(l) as unknown;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/**
 * Classification counts over the COMPLETE lines (those ending in a newline) of a possibly partial
 * `records.jsonl`. A line that is not a record is skipped. No replay-tail stripping (an interrupted
 * discovery has no replay). With `dropLastSequence` the records of the last fuzz sequence (from its last
 * `idx == 0` line to the end) are left out, the in-progress sequence of a handler fault.
 */
export function partialCountsFromJsonl(text: string, opts: { dropLastSequence?: boolean } = {}): ClassificationCounts {
  const parts = text.split("\n");
  parts.pop(); // the segment after the last newline is incomplete or empty
  const recs: { idx: number; classification: string }[] = [];
  for (const line of parts) {
    try {
      const v = JSON.parse(line) as { idx?: unknown; classification?: unknown };
      if (typeof v.idx === "number" && isClassification(v.classification)) {
        recs.push({ idx: v.idx, classification: v.classification });
      }
    } catch {
      // not a record
    }
  }
  let kept = recs;
  if (opts.dropLastSequence) {
    let start = -1;
    recs.forEach((r, i) => {
      if (r.idx === 0) start = i;
    });
    if (start >= 0) kept = recs.slice(0, start);
  }
  const counts = emptyCounts();
  for (const r of kept) counts[r.classification as keyof ClassificationCounts]++;
  return counts;
}

/**
 * Source files named as `path.sol:line:col` in compiler output (both solc 0.8 `--> path:line:col` and the
 * 0.4 `path:line:col: Error` forms), in first-seen order.
 */
export function failingFilesFromOutput(output: string): string[] {
  const files: string[] = [];
  for (const m of output.matchAll(/([\w@.\/-]+\.sol):\d+:\d+/g)) {
    if (!files.includes(m[1]!)) files.push(m[1]!);
  }
  return files;
}

const combined = (r: ProcessResult): string => [r.stdout, r.stderr].filter((x) => x !== "").join("\n");

/** Adds `tempDir` to `details` when `details` is absent or a plain object. */
function withTempDir(error: SeanceError, dir: string): SeanceError {
  const d = error.details;
  if (d === undefined) return { ...error, details: { tempDir: dir } } as SeanceError;
  if (typeof d === "object" && d !== null && !Array.isArray(d)) {
    return { ...error, details: { ...(d as Record<string, unknown>), tempDir: dir } } as SeanceError;
  }
  return error;
}

function revertsAndReason(json: unknown): { reverts: number; reason: string } {
  let reverts = 0;
  let reason = "";
  if (typeof json !== "object" || json === null) return { reverts, reason };
  for (const entry of Object.values(json as Record<string, unknown>)) {
    const results = (entry as { test_results?: Record<string, unknown> } | null)?.test_results;
    if (typeof results !== "object" || results === null) continue;
    for (const [name, r] of Object.entries(results)) {
      if (!name.startsWith("invariant_discovery")) continue;
      const res = r as { reason?: unknown; kind?: { Invariant?: { reverts?: unknown } } };
      const rv = res.kind?.Invariant?.reverts;
      if (typeof rv === "number") reverts += rv;
      if (typeof res.reason === "string" && res.reason !== "") reason = res.reason;
    }
  }
  return { reverts, reason };
}

/** Replaces (or creates) one project file. `writeProjectFiles` in add mode never overwrites, so the file is removed first. */
function replaceProjectFile(dir: string, files: ProjectFiles, path: string): Result<void> {
  const f = files.find((x) => x.path === path);
  if (f === undefined) return err(seanceError("SEANCE_FAILED", `project has no ${path}`));
  rmSync(join(dir, path), { force: true });
  return writeProjectFiles(dir, [f], { mode: "add" });
}

function toShrunkCalls(calls: HandlerCall[]): ShrunkSequence["calls"] {
  return calls.map((c) => ({ func_name: c.funcName, calldata: c.calldata, sender: c.sender }));
}

// --- the run ---------------------------------------------------------------

/**
 * Runs one séance. Order (design, Runner): validate, solc presence, fresh temp directory, (a) write
 * `src/` and `forge build`, (b) read the ABIs, bytecode check, ABI compatibility, autopsy report,
 * targets, (c) write `test/`, discovery, taint check, pair selection, witness campaigns, replays,
 * report. The temp project is removed on success and kept on failure (and on TIMEOUT).
 *
 * `input` is `unknown` so that the missing/invalid input errors can be produced here; it is checked
 * with `validateInput`. Deadline: one `Deadline` from `deps.now()` at entry and `timeoutSeconds`.
 */
export async function runSeance(input: unknown, deps: RunnerDeps): Promise<Result<SeanceRunResult>> {
  const valid = validateInput(input);
  if (!valid.ok) return valid;
  const inp = valid.value;

  // Deviation: the solc check runs before the directory is created, so a missing compiler leaves nothing behind.
  const solc = await checkSolcPresent(inp.legacySolcVersion, deps.solcInstalled);
  if (!solc.ok) return solc;

  let dir: string;
  try {
    dir = mkdtempSync(join(deps.tmpRoot, "exhume-seance-"));
  } catch (e) {
    return err(seanceError("SEANCE_FAILED", `could not create a temp project directory in ${deps.tmpRoot}: ${(e as Error).message}`));
  }

  let result: Result<SeanceRunResult>;
  try {
    result = await execute(inp, deps, dir);
  } catch (e) {
    result = err(seanceError("SEANCE_FAILED", `unexpected failure: ${(e as Error).stack ?? (e as Error).message}`));
  }

  if (result.ok) {
    if (deps.keepTempOnSuccess) return ok({ ...result.value, tempDir: dir });
    rmSync(dir, { recursive: true, force: true });
    return result;
  }
  if (deps.keepTempOnFailure === false) {
    rmSync(dir, { recursive: true, force: true });
    return result;
  }
  return err(withTempDir(result.error, dir));
}

async function execute(
  inp: SeanceInput,
  deps: RunnerDeps,
  dir: string,
): Promise<Result<SeanceRunResult>> {
  const startMs = deps.now();
  const deadline = makeDeadline(startMs, inp.timeoutSeconds ?? 300);
  const budget = (): number => phaseBudgetMs(deadline, deps.now());
  const forgeBin = deps.forgeBin ?? "forge";
  const genOpts: GeneratorOptions = {
    ...deps.generatorOptions,
    forgeStdDir: deps.forgeStdDir ?? FORGE_STD_DEFAULT_DIR,
  };
  const forgeOpts: ForgeOpts = inp.fuzzSeed === undefined ? {} : { fuzzSeed: inp.fuzzSeed };
  const name = inp.contractName;

  const runPhase = async (phase: Phase, timeoutMs: number): Promise<Result<ProcessResult>> => {
    const a = buildForgeArgs(phase, forgeOpts);
    if (!a.ok) return a;
    return ok(await deps.runner.run(forgeBin, a.value.args, { cwd: dir, env: a.value.env, timeoutMs }));
  };

  // ---- (a) src stage and forge build -------------------------------------
  const srcFiles = generateSrcProject(inp, genOpts);
  if (!srcFiles.ok) return srcFiles;
  const wrote = writeProjectFiles(dir, srcFiles.value, { mode: "fresh" });
  if (!wrote.ok) return wrote;

  const buildBudget = budget();
  if (buildBudget === 0) {
    return err(timeoutError("build", "deadline reached before forge build started; no process was launched"));
  }
  const built = await runPhase({ kind: "build" }, buildBudget);
  if (!built.ok) return built;
  if (built.value.timedOut) {
    return err(timeoutError("build", `deadline reached during forge build (${buildBudget} ms budget); forge was killed`));
  }
  if (built.value.code !== 0) {
    const output = combined(built.value);
    const files = failingFilesFromOutput(output);
    return err(
      seanceError(
        "BUILD_FAILED",
        `forge build failed (exit ${String(built.value.code)})${files.length > 0 ? `; failing files: ${files.join(", ")}` : ""}\n${output}`,
        { output, files, exitCode: built.value.code },
      ),
    );
  }

  // ---- (b) ABIs, bytecode, ABI compatibility, autopsy report -------------
  const outDir = join(dir, "out");
  const legacy = readLegacyArtifact(outDir, name);
  if (!legacy.ok) return legacy;
  const port = readPortArtifact(outDir, name);
  if (!port.ok) return port;
  const abi = legacy.value.abi;

  const code = compareRuntimeCode(legacy.value.runtimeCode, inp.onChainRuntimeCode);
  if (!code.ok) return code;
  const compat = compareAbis(abi, port.value);
  if (!compat.ok) return compat;

  // The autopsy check needs the ABI, so it runs after the build (design: where the autopsy check runs).
  const autopsy = parseAutopsyReport(inp.autopsyReport, abi);
  if (!autopsy.ok) return autopsy;
  const skippedFunctions = computeSkippedFunctions(abi);
  const plan = generateTargets(autopsy.value, abi, new Set(skippedFunctions.map((s) => s.name)));
  if (!plan.ok) return plan;

  // ---- (c) test stage and discovery ---------------------------------------
  const testFiles = generateTestProject(inp, plan.value, abi, genOpts);
  if (!testFiles.ok) return testFiles;
  const added = writeProjectFiles(dir, testFiles.value.files, { mode: "add" });
  if (!added.ok) return added;
  let project: ProjectFiles = [...srcFiles.value, ...testFiles.value.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const recordsPath = join(dir, RECORDS_FILE);
  const discBudget = budget();
  if (discBudget === 0) {
    return err(
      timeoutError("discovery", "deadline reached before discovery started; no process was launched", {
        partialCounts: partialCountsFromJsonl(readOptional(recordsPath)),
      }),
    );
  }
  const disc = await runPhase({ kind: "discovery" }, discBudget);
  if (!disc.ok) return disc;
  if (disc.value.timedOut) {
    return err(
      timeoutError("discovery", `deadline reached during discovery (${discBudget} ms budget); forge was killed`, {
        partialCounts: partialCountsFromJsonl(readOptional(recordsPath)),
      }),
    );
  }
  const discJson = parseForgeJson(disc.value.stdout);
  if (discJson === undefined) {
    const output = combined(disc.value);
    if (disc.value.code !== 0) {
      // Test compilation (for example "Stack too deep") or forge itself failed before any result.
      const files = failingFilesFromOutput(output);
      return err(
        seanceError("BUILD_FAILED", `forge test failed before discovery produced a result (exit ${String(disc.value.code)})\n${output}`, {
          output,
          files,
          exitCode: disc.value.code,
        }),
      );
    }
    return err(seanceError("SEANCE_FAILED", "discovery printed no JSON result", { output }));
  }
  const status = testStatus(discJson, { contract: "SeanceDiscovery", test: "invariant_discovery" });
  if (!status.ok) return status;
  const { reverts, reason } = revertsAndReason(discJson);
  if (status.value === "Failure" || reverts > 0) {
    // The handler reverted (fail_on_revert): an engine fault. The in-progress (last) sequence is not counted.
    return err(
      handlerFaultError(
        `discovery invariant failed: the handler reverted${reason !== "" ? ` (${reason})` : ""}${reverts > 0 ? `; ${reverts} reverts` : ""}`,
        { partialCounts: partialCountsFromJsonl(readOptional(recordsPath), { dropLastSequence: true }), details: { reason, reverts } },
      ),
    );
  }
  if (status.value !== "Success" || disc.value.code !== 0) {
    return err(
      seanceError("SEANCE_FAILED", `discovery ended with status ${status.value} and exit code ${String(disc.value.code)}`, {
        output: combined(disc.value),
      }),
    );
  }

  // ---- records, taint, pair selection -------------------------------------
  if (!existsSync(recordsPath)) {
    return err(seanceError("SEANCE_FAILED", `discovery succeeded but wrote no ${RECORDS_FILE}`));
  }
  const parsed = parseRecords(readFileSync(recordsPath, "utf8"), INVARIANT_RUNS);
  if (!parsed.ok) return parsed;
  const taint = verifyTaint(parsed.value.records);
  if (!taint.ok) return taint;

  const pairs = selectFindingPairs(parsed.value);
  const initial = assignDispositions(pairs);
  // Selected for witness shrinking: fuzz pairs inside the cap, in order. k is the 1-based position here.
  const selected: Pair[] = initial.dispositions.filter((d) => d.disposition === "shrink").map((d) => d.pair);

  const progress: PairProgress = {
    witnessDone: new Set<string>(),
    replayDone: new Set<string>(),
    deadlineReached: false,
    outcomes: new Map<string, ShrinkOutcome>(),
  };

  // ---- phase 2: witness campaigns -----------------------------------------
  const failedCalls = new Map<number, HandlerCall[]>(); // k -> shrunk calls
  if (selected.length > 0) {
    const regenW = regenerateWitness(project, abi, selected.map((p) => ({ function: p.function, classification: p.classification })));
    if (!regenW.ok) return regenW;
    project = regenW.value;
    const wroteW = replaceProjectFile(dir, project, "test/Witness.t.sol");
    if (!wroteW.ok) return wroteW;

    for (let i = 0; i < selected.length && !progress.deadlineReached; i++) {
      const k = i + 1;
      const pair = selected[i]!;
      const b = budget();
      if (b === 0) {
        progress.deadlineReached = true;
        break;
      }
      const r = await runPhase({ kind: "witness", k }, b);
      if (!r.ok) return r;
      if (r.value.timedOut) {
        progress.deadlineReached = true;
        break;
      }
      const json = parseForgeJson(r.value.stdout);
      if (json === undefined) {
        return err(seanceError("SEANCE_FAILED", `witness campaign ${k} printed no JSON result (exit ${String(r.value.code)})`, { output: combined(r.value) }));
      }
      const ce = parseCounterexample(json, { contract: `Witness${k}`, test: "invariant_witness" });
      if (!ce.ok) return ce;
      const key = pairKey(pair);
      progress.witnessDone.add(key);
      if (ce.value.kind === "none") {
        progress.outcomes.set(key, { witness: "not-failed" });
      } else {
        progress.outcomes.set(key, { witness: "failed", originalLength: ce.value.originalLength });
        failedCalls.set(k, ce.value.calls);
      }
    }
  }

  // ---- phase 3: replays ---------------------------------------------------
  if (!progress.deadlineReached && failedCalls.size > 0) {
    const sequences: ShrunkSequence[] = [...failedCalls.entries()].map(([k, calls]) => ({ k, calls: toShrunkCalls(calls) }));
    const regenR = regenerateReplay(project, abi, sequences);
    if (!regenR.ok) return regenR;
    project = regenR.value;
    const wroteR = replaceProjectFile(dir, project, "test/Replay.t.sol");
    if (!wroteR.ok) return wroteR;

    for (const { k } of sequences) {
      const pair = selected[k - 1]!;
      const b = budget();
      if (b === 0) {
        progress.deadlineReached = true;
        break;
      }
      const r = await runPhase({ kind: "replay", k }, b);
      if (!r.ok) return r;
      if (r.value.timedOut) {
        progress.deadlineReached = true;
        break;
      }
      if (r.value.code !== 0) {
        return err(seanceError("SEANCE_FAILED", `replay ${k} failed (exit ${String(r.value.code)})`, { output: combined(r.value) }));
      }
      const replayText = readOptional(join(dir, replayRecordsFile(k)));
      const replayParsed = parseRecords(replayText, INVARIANT_RUNS);
      if (!replayParsed.ok) return replayParsed;
      const seq = replayParsed.value.sequences[replayParsed.value.sequences.length - 1] ?? [];
      let at = -1;
      seq.forEach((rec, i) => {
        if (rec.function === pair.function && !rec.afterDivergence) at = i;
      });
      const key = pairKey(pair);
      const prev = progress.outcomes.get(key)!;
      const replay: NonNullable<ShrinkOutcome["replay"]> =
        at >= 0 ? { record: seq[at] as RecordLine, preceding: seq.slice(0, at) as RecordLine[] } : { preceding: [] };
      progress.outcomes.set(key, { ...prev, replay });
      progress.replayDone.add(key);
    }
  }

  // ---- report -------------------------------------------------------------
  const dispositions = assignDispositions(pairs, progress);
  if (dispositions.dispositions.some((d) => d.disposition === "shrink")) {
    return err(seanceError("SEANCE_FAILED", "internal error: a selected pair is neither finished nor marked deadline"));
  }
  const report = buildReport({
    contract: name,
    seed: inp.fuzzSeed ?? "",
    parsed: parsed.value,
    dispositions,
    autopsy: autopsy.value,
    abi,
    plan: plan.value,
    skippedFunctions: testFiles.value.skippedFunctions,
  });
  const checked = validateReport(report);
  if (!checked.ok) return checked;

  if (deps.graveyardRoot === undefined) return ok({ report: checked.value });
  const written = await writeReportAtomic(deps.graveyardRoot, deps.graveyardName ?? name, checked.value);
  if (!written.ok) return written;
  return ok({ report: checked.value, reportPath: written.value.path });
}
