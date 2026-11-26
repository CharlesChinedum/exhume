/**
 * Entry_Point command-line program (task 11.2, Requirement 12.3 to 12.6).
 *
 * `main(argv, io, deps)` is the testable core: it parses `argv` (without `node` and the script path),
 * runs one command and returns the process exit code. The bootstrap at the bottom of the file calls it
 * only when this module is the program being run, and sets `process.exitCode`.
 *
 * Running: `pnpm --filter @exhume/engine seance -- <args>` (script `tsx src/seance/cli.ts`). The sources
 * import each other with `.js` specifiers, which Node's type stripping cannot resolve, so `tsx` runs them
 * directly and no build step exists.
 *
 * Output contract: stdout carries exactly one JSON document. On success it is the canonical report
 * (`serializeReport`). On any failure it is `{ "error": { code, message, details?, phase?, partialCounts? } }`.
 * Progress, the written report path and usage hints go to stderr. Stack traces are printed (to stderr)
 * only with `--debug`.
 *
 * Exit codes (the design only says "non-zero on any error"; this table is defined by task 11.2):
 *   0 success
 *   1 unexpected exception (reported as SEANCE_FAILED)
 *   2 MISSING_INPUT, INVALID_INPUT, AUTOPSY_REJECTED, usage errors
 *   3 SOLC_MISSING, BUILD_FAILED, BYTECODE_MISMATCH
 *   4 TIMEOUT
 *   5 HANDLER_FAULT, SEANCE_FAILED, REPORT_WRITE_FAILED
 *   6 ACCEPTANCE_FAILED
 *
 * `--input <file.json>` format (not defined by the design; defined here): a JSON object with the
 * `SeanceInput` fields. The large text fields may be given inline or through a sibling `*Path` field,
 * a file path relative to the JSON file's directory (or absolute). Giving both is INVALID_INPUT.
 *   legacySource      <- legacySourcePath
 *   portSource        <- portSourcePath
 *   autopsyReport     <- autopsyReportPath
 *   onChainRuntimeCode <- runtimeCodePath   (surrounding whitespace is trimmed)
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runBecAcceptance, type BecAcceptanceRun } from "./acceptance.js";
import { defaultGraveyardRoot, resolveDeps, runSeanceEntry, type SeanceOptions } from "./entry.js";
import { loadGraveyardInput } from "./graveyard.js";
import { serializeReport } from "./report.js";
import type { SeanceRunResult } from "./runner.js";
import { err, ok, seanceError, type Result, type SeanceError } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Used for the forge overrides in `resolveDeps`. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Relative paths of the flags resolve against it. Default: `process.cwd()`. */
  cwd?: string;
}

export interface CliDeps {
  /** Default: `runSeanceEntry`. */
  runSeance?: (input: unknown, opts: SeanceOptions) => Promise<Result<SeanceRunResult>>;
  /** Default: `runBecAcceptance` over `resolveDeps(opts)`. */
  runAcceptance?: (opts: SeanceOptions, run: { fuzzSeed?: string; timeoutSeconds?: number }) => Promise<Result<BecAcceptanceRun>>;
}

export const EXIT_OK = 0;
export const EXIT_UNEXPECTED = 1;
export const EXIT_INPUT = 2;
export const EXIT_ENVIRONMENT = 3;
export const EXIT_TIMEOUT = 4;
export const EXIT_RUN = 5;
export const EXIT_ACCEPTANCE = 6;

export function exitCodeFor(code: string): number {
  switch (code) {
    case "MISSING_INPUT":
    case "INVALID_INPUT":
    case "AUTOPSY_REJECTED":
      return EXIT_INPUT;
    case "SOLC_MISSING":
    case "BUILD_FAILED":
    case "BYTECODE_MISMATCH":
      return EXIT_ENVIRONMENT;
    case "TIMEOUT":
      return EXIT_TIMEOUT;
    case "HANDLER_FAULT":
    case "SEANCE_FAILED":
    case "REPORT_WRITE_FAILED":
      return EXIT_RUN;
    case "ACCEPTANCE_FAILED":
      return EXIT_ACCEPTANCE;
    default:
      return EXIT_UNEXPECTED;
  }
}

export const HELP_TEXT = `Usage:
  seance run --graveyard <name> [options]     run the séance for graveyard/<name>/
  seance run --input <file.json> [options]    run the séance for a JSON input file
  seance accept-bec [options]                 run the BEC acceptance (writes graveyard/bec/seance-report.json only on a pass)
  seance --help

Options:
  --graveyard-root <dir>   parent of the graveyard entries and of the written report (default: <repo>/graveyard)
  --seed <n|0x..>          fuzz seed (decimal or 0x hex); overrides "fuzzSeed" of the input file
  --timeout <seconds>      one deadline for build and all phases (default 300); overrides "timeoutSeconds"
  --forge-std-dir <dir>    forge-std checkout (default: $SEANCE_FORGE_STD_DIR, else /opt/forge-std)
  --forge-bin <path>       forge executable (default: $SEANCE_FORGE_BIN, else "forge")
  --tmp-root <dir>         existing parent of the temporary project directories (default: the OS temp dir)
  --debug                  print stack traces of unexpected exceptions to stderr
  -h, --help               print this text

Input file (--input): a JSON object with the SeanceInput fields (contractName, legacySource, portSource,
autopsyReport, legacySolcVersion, legacyOptimizer, legacyOptimizerRuns, onChainRuntimeCode, constructorArgs,
fuzzSeed, timeoutSeconds). The text fields may instead be given as files, relative to the JSON file's directory:
  legacySourcePath, portSourcePath, autopsyReportPath, runtimeCodePath
(giving both the inline field and its *Path field is an error). The report goes to <graveyard-root>/<contractName>/.

Output: stdout is one JSON document. Success: the séance report, exit 0 (the report path goes to stderr).
Failure: {"error":{"code","message","details"?,"phase"?,"partialCounts"?}} and a non-zero exit code:
  1 unexpected   2 MISSING_INPUT / INVALID_INPUT / AUTOPSY_REJECTED / usage   3 SOLC_MISSING / BUILD_FAILED / BYTECODE_MISMATCH
  4 TIMEOUT      5 HANDLER_FAULT / SEANCE_FAILED / REPORT_WRITE_FAILED       6 ACCEPTANCE_FAILED
`;

// ---------------------------------------------------------------------------
// Input file normalisation
// ---------------------------------------------------------------------------

const PATH_FIELDS = [
  ["legacySource", "legacySourcePath", false],
  ["portSource", "portSourcePath", false],
  ["autopsyReport", "autopsyReportPath", false],
  ["onChainRuntimeCode", "runtimeCodePath", true],
] as const;

const invalid = (message: string, details?: unknown): Result<never> => err(seanceError("INVALID_INPUT", message, details));

/**
 * Replaces each `*Path` field of a parsed input file by the text of the file it names (relative to
 * `baseDir`). Pure apart from reading those files. Everything else (including missing or invalid fields)
 * is left for `validateInput`.
 */
export function normalizeCliInputFile(parsedJson: unknown, baseDir: string): Result<unknown> {
  if (typeof parsedJson !== "object" || parsedJson === null || Array.isArray(parsedJson)) {
    return invalid("The input file must contain a JSON object");
  }
  const out: Record<string, unknown> = { ...(parsedJson as Record<string, unknown>) };
  for (const [field, pathField, trim] of PATH_FIELDS) {
    const given = out[pathField];
    delete out[pathField];
    if (given === undefined || given === null) continue;
    if (out[field] !== undefined && out[field] !== null) {
      return invalid(`Give either "${field}" or "${pathField}", not both`, { field, pathField });
    }
    if (typeof given !== "string" || given === "") return invalid(`"${pathField}" must be a non-empty file path`, { field: pathField });
    const path = isAbsolute(given) ? given : resolve(baseDir, given);
    try {
      const text = readFileSync(path, "utf8");
      out[field] = trim ? text.trim() : text;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return invalid(`Cannot read "${pathField}" ${path} (${code ?? "read error"})`, { field: pathField, path });
    }
  }
  return ok(out);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface Parsed {
  command: string;
  values: Map<string, string>;
  debug: boolean;
  help: boolean;
}

const VALUE_FLAGS: Record<string, readonly string[]> = {
  run: ["graveyard", "input", "graveyard-root", "seed", "timeout", "forge-std-dir", "forge-bin", "tmp-root"],
  "accept-bec": ["graveyard-root", "seed", "timeout", "forge-std-dir", "forge-bin", "tmp-root"],
};

function parseArgs(argv: readonly string[]): Result<Parsed> {
  const args = [...argv];
  // `pnpm run seance -- <args>` may forward the separator.
  while (args[0] === "--") args.shift();
  const values = new Map<string, string>();
  let debug = false;
  let help = false;
  let command = "";
  const rest: string[] = [];
  for (const a of args) {
    if (a === "-h" || a === "--help") help = true;
    else rest.push(a);
  }
  if (help) return ok({ command, values, debug, help });
  command = rest.shift() ?? "";
  if (command === "") return invalid("Missing command: expected 'run' or 'accept-bec' (see --help)");
  const allowed = VALUE_FLAGS[command];
  if (allowed === undefined) return invalid(`Unknown command: ${command} (expected 'run' or 'accept-bec')`);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) return invalid(`Unexpected argument: ${a}`);
    if (a === "--debug") {
      debug = true;
      continue;
    }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq === -1 ? undefined : eq);
    if (!allowed.includes(name)) return invalid(`Unknown flag: --${name}`);
    let value: string | undefined;
    if (eq !== -1) value = a.slice(eq + 1);
    else {
      value = rest[i + 1];
      i++;
    }
    if (value === undefined || (eq === -1 && value.startsWith("--")) || value === "") {
      return invalid(`Flag --${name} needs a value`);
    }
    if (values.has(name)) return invalid(`Flag --${name} given more than once`);
    values.set(name, value);
  }
  return ok({ command, values, debug, help });
}

function parseTimeout(text: string | undefined): Result<number | undefined> {
  if (text === undefined) return ok(undefined);
  if (!/^\d+$/.test(text)) return invalid(`--timeout must be a whole number of seconds, got "${text}"`);
  const n = Number(text);
  if (!Number.isSafeInteger(n)) return invalid(`--timeout is too large: ${text}`);
  return ok(n);
}

function parseSeed(text: string | undefined): Result<string | undefined> {
  if (text === undefined) return ok(undefined);
  if (!/^(?:0|[1-9]\d*|0x[0-9a-fA-F]+)$/.test(text)) return invalid(`--seed must be a decimal number or 0x hex, got "${text}"`);
  return ok(text);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function jsonSafe(_key: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString(10) : v;
}

/** The structured error as printed on stdout. */
export function errorDocument(e: SeanceError, debug: boolean): string {
  let message = e.message;
  let details = e.details;
  if (!debug) {
    // The runner and entry fold a stack into some unexpected failures; the CLI shows it only with --debug.
    if (message.startsWith("unexpected failure:")) message = message.split("\n")[0]!;
    if (typeof details === "object" && details !== null && "stackHint" in details) {
      const { stackHint: _drop, ...others } = details as Record<string, unknown>;
      details = Object.keys(others).length > 0 ? others : undefined;
    }
  }
  const body: Record<string, unknown> = { code: e.code, message };
  if (details !== undefined) body.details = details;
  if (e.phase !== undefined) body.phase = e.phase;
  if (e.partialCounts !== undefined) body.partialCounts = e.partialCounts;
  return JSON.stringify({ error: body }, jsonSafe, 2) + "\n";
}

function fail(io: CliIo, e: SeanceError, debug: boolean): number {
  io.stdout(errorDocument(e, debug));
  return exitCodeFor(e.code);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function optionsFrom(p: Parsed, io: CliIo): SeanceOptions {
  const cwd = io.cwd ?? process.cwd();
  const path = (name: string): string | undefined => {
    const v = p.values.get(name);
    return v === undefined ? undefined : resolve(cwd, v);
  };
  const forgeBin = p.values.get("forge-bin");
  const root = path("graveyard-root");
  const std = path("forge-std-dir");
  const tmp = path("tmp-root");
  return {
    ...(root !== undefined && { graveyardRoot: root }),
    ...(std !== undefined && { forgeStdDir: std }),
    ...(tmp !== undefined && { tmpRoot: tmp }),
    // A bare command name ("forge") is looked up on PATH; only a path is resolved against the cwd.
    ...(forgeBin !== undefined && { forgeBin: /[\\/]/.test(forgeBin) ? resolve(cwd, forgeBin) : forgeBin }),
    ...(io.env !== undefined && { env: io.env }),
  };
}

function emitSuccess(io: CliIo, report: SeanceRunResult["report"], reportPath: string | undefined): number {
  io.stdout(serializeReport(report));
  if (reportPath !== undefined) io.stderr(`report written to ${reportPath}\n`);
  return EXIT_OK;
}

async function runCommand(p: Parsed, io: CliIo, deps: CliDeps): Promise<number> {
  const graveyard = p.values.get("graveyard");
  const inputFile = p.values.get("input");
  if (graveyard === undefined && inputFile === undefined) {
    return fail(io, seanceError("MISSING_INPUT", "Missing input: give --graveyard <name> or --input <file.json>"), p.debug);
  }
  if (graveyard !== undefined && inputFile !== undefined) {
    return fail(io, seanceError("INVALID_INPUT", "Give either --graveyard or --input, not both"), p.debug);
  }
  const timeout = parseTimeout(p.values.get("timeout"));
  if (!timeout.ok) return fail(io, timeout.error, p.debug);
  const seed = parseSeed(p.values.get("seed"));
  if (!seed.ok) return fail(io, seed.error, p.debug);
  const opts = optionsFrom(p, io);
  const cwd = io.cwd ?? process.cwd();

  let input: unknown;
  if (graveyard !== undefined) {
    const root = opts.graveyardRoot ?? defaultGraveyardRoot();
    const loaded = loadGraveyardInput(root, graveyard, {
      ...(seed.value !== undefined && { fuzzSeed: seed.value }),
      ...(timeout.value !== undefined && { timeoutSeconds: timeout.value }),
    });
    if (!loaded.ok) return fail(io, loaded.error, p.debug);
    input = loaded.value;
    opts.graveyardName = graveyard;
  } else {
    const file = resolve(cwd, inputFile!);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const why = e instanceof SyntaxError ? "is not valid JSON" : `cannot be read (${code ?? "read error"})`;
      return fail(io, seanceError("INVALID_INPUT", `Input file ${file} ${why}`, { path: file }), p.debug);
    }
    const normalised = normalizeCliInputFile(parsed, dirname(file));
    if (!normalised.ok) return fail(io, normalised.error, p.debug);
    input = {
      ...(normalised.value as Record<string, unknown>),
      ...(seed.value !== undefined && { fuzzSeed: seed.value }),
      ...(timeout.value !== undefined && { timeoutSeconds: timeout.value }),
    };
  }

  io.stderr("running séance...\n");
  const r = await (deps.runSeance ?? runSeanceEntry)(input, opts);
  if (!r.ok) return fail(io, r.error, p.debug);
  return emitSuccess(io, r.value.report, r.value.reportPath);
}

async function acceptBecCommand(p: Parsed, io: CliIo, deps: CliDeps): Promise<number> {
  const timeout = parseTimeout(p.values.get("timeout"));
  if (!timeout.ok) return fail(io, timeout.error, p.debug);
  const seed = parseSeed(p.values.get("seed"));
  if (!seed.ok) return fail(io, seed.error, p.debug);
  const opts = optionsFrom(p, io);
  const run = {
    ...(seed.value !== undefined && { fuzzSeed: seed.value }),
    ...(timeout.value !== undefined && { timeoutSeconds: timeout.value }),
  };
  io.stderr("running BEC acceptance...\n");
  const defaultAcceptance: NonNullable<CliDeps["runAcceptance"]> = (o, r) => {
    const { graveyardName: _unused, graveyardRoot, ...bec } = resolveDeps(o);
    return runBecAcceptance({ ...bec, graveyardRoot: graveyardRoot ?? defaultGraveyardRoot() }, r);
  };
  const r = await (deps.runAcceptance ?? defaultAcceptance)(opts, run);
  if (!r.ok) return fail(io, r.error, p.debug);
  return emitSuccess(io, r.value.report, r.value.reportPath);
}

/** Runs the CLI and returns the exit code. Never rejects. */
export async function main(argv: readonly string[], io: CliIo, deps: CliDeps = {}): Promise<number> {
  let debug = argv.includes("--debug");
  try {
    const parsed = parseArgs(argv);
    if (!parsed.ok) {
      io.stderr("Run with --help for usage.\n");
      return fail(io, parsed.error, debug);
    }
    const p = parsed.value;
    debug = p.debug;
    if (p.help) {
      io.stdout(HELP_TEXT);
      return EXIT_OK;
    }
    return p.command === "run" ? await runCommand(p, io, deps) : await acceptBecCommand(p, io, deps);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (debug && e instanceof Error && e.stack !== undefined) io.stderr(`${e.stack}\n`);
    io.stdout(errorDocument(seanceError("SEANCE_FAILED", `unexpected failure: ${message.split("\n")[0] ?? ""}`), debug));
    return EXIT_UNEXPECTED;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function isMainModule(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(script).href;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2), {
    stdout: (t) => void process.stdout.write(t),
    stderr: (t) => void process.stderr.write(t),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = EXIT_UNEXPECTED;
    },
  );
}
