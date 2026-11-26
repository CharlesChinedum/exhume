/**
 * Loads a graveyard entry (`<root>/<name>/`) into a validated `SeanceInput` (task 13.1).
 *
 * Files read:
 *  - `metadata.json`: solc version, optimizer, and the compilation target (file and contract name);
 *  - the legacy source named by the compilation target (read as UTF-8 text, line endings untouched, so the
 *    autopsy `location` line/column numbers and the bytecode check refer to the same bytes);
 *  - `port.golden.sol`: the golden port;
 *  - `autopsy.json`: the autopsy report text;
 *  - `runtime.hex`: the mainnet runtime code, normalised to lowercase `0x` hex.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateInput } from "./inputs.js";
import { err, ok, seanceError, type Result, type SeanceInput } from "./types.js";

export const PORT_GOLDEN_FILE = "port.golden.sol";
export const AUTOPSY_FILE = "autopsy.json";
export const RUNTIME_FILE = "runtime.hex";
export const METADATA_FILE = "metadata.json";

const invalid = (message: string, details?: unknown) => err(seanceError("INVALID_INPUT", message, details));

function readText(path: string): Result<string> {
  try {
    return ok(readFileSync(path, "utf8"));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return invalid(`Cannot read graveyard file ${path} (${code ?? "read error"})`, { path });
  }
}

/** `0x`-prefixed lowercase hex from file text; surrounding whitespace is dropped. */
function normaliseHex(text: string): string {
  const t = text.trim();
  const body = /^0x/i.test(t) ? t.slice(2) : t;
  return "0x" + body.toLowerCase();
}

interface MetadataFacts {
  file: string;
  contractName: string;
  solc: string;
  optimizer: boolean;
  runs?: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseMetadata(text: string, path: string): Result<MetadataFacts> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return invalid(`Graveyard metadata ${path} is not valid JSON`, { path });
  }
  if (!isObj(raw)) return invalid(`Graveyard metadata ${path} must be a JSON object`, { path });
  const version = isObj(raw.compiler) ? raw.compiler.version : undefined;
  if (typeof version !== "string") return invalid(`Graveyard metadata ${path}: compiler.version is missing`, { path });
  const m = /^(\d+\.\d+\.\d+)(?:\+.*)?$/.exec(version);
  if (!m) return invalid(`Graveyard metadata ${path}: cannot parse compiler.version`, { path });
  const settings = raw.settings;
  const opt = isObj(settings) ? settings.optimizer : undefined;
  if (!isObj(opt) || typeof opt.enabled !== "boolean") {
    return invalid(`Graveyard metadata ${path}: settings.optimizer.enabled is missing`, { path });
  }
  let runs: number | undefined;
  if (opt.enabled) {
    if (typeof opt.runs !== "number") return invalid(`Graveyard metadata ${path}: settings.optimizer.runs is missing`, { path });
    runs = opt.runs;
  }
  const target = isObj(settings) ? settings.compilationTarget : undefined;
  const entries = isObj(target) ? Object.entries(target) : [];
  if (entries.length !== 1) {
    return invalid(`Graveyard metadata ${path}: settings.compilationTarget must name exactly one file`, { path });
  }
  const [file, contractName] = entries[0]!;
  if (typeof contractName !== "string" || file.includes("/") || file.includes("\\") || file.includes("..") || !file.endsWith(".sol")) {
    return invalid(`Graveyard metadata ${path}: settings.compilationTarget is not a plain .sol file name`, { path });
  }
  return ok({ file, contractName, solc: m[1]!, optimizer: opt.enabled, ...(runs !== undefined && { runs }) });
}

export function loadGraveyardInput(
  graveyardRoot: string,
  name: string,
  opts: { fuzzSeed?: string; timeoutSeconds?: number } = {},
): Result<SeanceInput> {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) return invalid(`Invalid graveyard entry name: ${name}`, { name });
  const dir = join(graveyardRoot, name);

  const metaPath = join(dir, METADATA_FILE);
  const metaText = readText(metaPath);
  if (!metaText.ok) return metaText;
  const meta = parseMetadata(metaText.value, metaPath);
  if (!meta.ok) return meta;

  const legacy = readText(join(dir, meta.value.file));
  if (!legacy.ok) return legacy;
  const port = readText(join(dir, PORT_GOLDEN_FILE));
  if (!port.ok) return port;
  const autopsy = readText(join(dir, AUTOPSY_FILE));
  if (!autopsy.ok) return autopsy;
  const runtime = readText(join(dir, RUNTIME_FILE));
  if (!runtime.ok) return runtime;

  return validateInput({
    contractName: meta.value.contractName,
    legacySource: legacy.value,
    portSource: port.value,
    autopsyReport: autopsy.value,
    legacySolcVersion: meta.value.solc,
    legacyOptimizer: meta.value.optimizer,
    ...(meta.value.runs !== undefined && { legacyOptimizerRuns: meta.value.runs }),
    onChainRuntimeCode: normaliseHex(runtime.value),
    ...(opts.fuzzSeed !== undefined && { fuzzSeed: opts.fuzzSeed }),
    ...(opts.timeoutSeconds !== undefined && { timeoutSeconds: opts.timeoutSeconds }),
  });
}
