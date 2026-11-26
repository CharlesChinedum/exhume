/**
 * Séance input validation (design: "Input validation (`inputs.ts`)").
 *
 * `validateInput` is pure: it never mutates `raw` and returns a fresh,
 * normalised `SeanceInput`. Every missing field is reported together in one
 * `MISSING_INPUT` error, or, when nothing is missing, every invalid field in
 * one `INVALID_INPUT` error. When both kinds exist, `MISSING_INPUT` wins
 * (Requirement 12.4 is checked before 12.5); the invalid fields are reported
 * once the missing ones are supplied.
 *
 * Error shape:
 * - MISSING_INPUT: `details = { fields: string[] }`
 * - INVALID_INPUT: `details = { fields: string[], reasons: Record<string, string> }`
 * `fields` follows the field order of `SeanceInput` in the design.
 */

import { err, ok, seanceError, type Result, type SeanceInput } from "./types.js";

export const MAX_SOURCE_BYTES = 1_048_576; // 1 MiB
export const MAX_CONTRACT_NAME_LENGTH = 128;
export const MAX_OPTIMIZER_RUNS = 4_294_967_295;
export const DEFAULT_TIMEOUT_SECONDS = 300;
export const DEFAULT_CONSTRUCTOR_ARGS = "0x";

/** Same rule as foundry-config.ts: the name appears in file names and foundry.toml. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `0.x.y`, minor 0..7, no leading zeros. */
const LEGACY_SOLC = /^0\.[0-7]\.(0|[1-9]\d*)$/;
const EVEN_HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const FUZZ_SEED = /^(?:0|[1-9]\d*|0x[0-9a-fA-F]+)$/;
const MAX_UINT256 = (1n << 256n) - 1n;

/** Field order of `SeanceInput` in the design; error output is sorted by it. */
export const INPUT_FIELD_ORDER = [
  "contractName",
  "legacySource",
  "portSource",
  "autopsyReport",
  "legacySolcVersion",
  "legacyOptimizer",
  "legacyOptimizerRuns",
  "onChainRuntimeCode",
  "constructorArgs",
  "fuzzSeed",
  "timeoutSeconds",
] as const;
type Field = (typeof INPUT_FIELD_ORDER)[number];

const REQUIRED: readonly Field[] = [
  "contractName",
  "legacySource",
  "portSource",
  "autopsyReport",
  "legacySolcVersion",
  "legacyOptimizer",
  "onChainRuntimeCode",
];

const absent = (v: unknown): boolean => v === undefined || v === null;

function checkSource(v: unknown): string | undefined {
  if (typeof v !== "string") return "must be a string";
  if (v.length === 0) return "must not be empty";
  if (Buffer.byteLength(v, "utf8") > MAX_SOURCE_BYTES) return `must be at most ${MAX_SOURCE_BYTES} bytes (1 MiB) of UTF-8`;
  return undefined;
}

function checkContractName(v: unknown): string | undefined {
  if (typeof v !== "string") return "must be a string";
  if (v.length === 0) return "must not be empty";
  if (v.length > MAX_CONTRACT_NAME_LENGTH) return `must be at most ${MAX_CONTRACT_NAME_LENGTH} characters`;
  if (!IDENTIFIER.test(v)) return "must match [A-Za-z_][A-Za-z0-9_]*";
  return undefined;
}

function checkSolc(v: unknown): string | undefined {
  if (typeof v !== "string") return "must be a string";
  if (!LEGACY_SOLC.test(v)) return "must be a version 0.x.y with minor below 8 (for example 0.4.19)";
  return undefined;
}

function checkRuns(v: unknown): string | undefined {
  if (typeof v !== "number" || !Number.isInteger(v)) return "must be an integer";
  if (v < 0 || v > MAX_OPTIMIZER_RUNS) return `must be between 0 and ${MAX_OPTIMIZER_RUNS}`;
  return undefined;
}

function checkRuntimeCode(v: unknown): string | undefined {
  if (typeof v !== "string") return "must be a string";
  if (v === "0x") return "must not be empty";
  if (!EVEN_HEX.test(v)) return "must be 0x-prefixed hex with an even number of digits";
  return undefined;
}

function checkConstructorArgs(v: unknown): string | undefined {
  if (typeof v !== "string") return "must be a string";
  if (!EVEN_HEX.test(v)) return "must be 0x-prefixed hex with an even number of digits";
  return undefined;
}

function checkFuzzSeed(v: unknown): string | undefined {
  if (typeof v !== "string") return "must be a string";
  if (!FUZZ_SEED.test(v)) return "must be a decimal integer or 0x-prefixed hex";
  if (BigInt(v) > MAX_UINT256) return "must fit in 256 bits";
  return undefined;
}

function checkTimeout(v: unknown): string | undefined {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) return "must be an integer";
  if (v <= 0) return "must be positive";
  return undefined;
}

export function validateInput(raw: unknown): Result<SeanceInput> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err(
      seanceError("INVALID_INPUT", "Invalid input: input (must be an object)", {
        fields: ["input"],
        reasons: { input: "must be an object" },
      }),
    );
  }
  const r = raw as Record<string, unknown>;
  const get = (f: Field): unknown => (Object.prototype.hasOwnProperty.call(r, f) ? r[f] : undefined);

  const missing = new Set<Field>(REQUIRED.filter((f) => absent(get(f))));
  // Runs are required only when the optimizer is enabled.
  if (get("legacyOptimizer") === true && absent(get("legacyOptimizerRuns"))) missing.add("legacyOptimizerRuns");

  if (missing.size > 0) {
    const fields = INPUT_FIELD_ORDER.filter((f) => missing.has(f));
    return err(seanceError("MISSING_INPUT", `Missing input: ${fields.join(", ")}`, { fields }));
  }

  const reasons: Partial<Record<Field, string>> = {};
  const check = (f: Field, fn: (v: unknown) => string | undefined): void => {
    const v = get(f);
    if (absent(v)) return;
    const reason = fn(v);
    if (reason !== undefined) reasons[f] = reason;
  };
  check("contractName", checkContractName);
  check("legacySource", checkSource);
  check("portSource", checkSource);
  // Emptiness, JSON syntax and the 10 MB cap are AUTOPSY_REJECTED's job, not ours.
  check("autopsyReport", (v) => (typeof v === "string" ? undefined : "must be a string"));
  check("legacySolcVersion", checkSolc);
  check("legacyOptimizer", (v) => (typeof v === "boolean" ? undefined : "must be a boolean"));
  // A supplied runs value is ignored (and dropped) when the optimizer is not enabled.
  if (get("legacyOptimizer") === true) check("legacyOptimizerRuns", checkRuns);
  check("onChainRuntimeCode", checkRuntimeCode);
  check("constructorArgs", checkConstructorArgs);
  check("fuzzSeed", checkFuzzSeed);
  check("timeoutSeconds", checkTimeout);

  const bad = INPUT_FIELD_ORDER.filter((f) => reasons[f] !== undefined);
  if (bad.length > 0) {
    const outReasons: Record<string, string> = {};
    for (const f of bad) outReasons[f] = reasons[f] as string;
    const text = bad.map((f) => `${f} (${outReasons[f]})`).join(", ");
    return err(seanceError("INVALID_INPUT", `Invalid input: ${text}`, { fields: bad, reasons: outReasons }));
  }

  const optimizer = get("legacyOptimizer") as boolean;
  const value: SeanceInput = {
    contractName: get("contractName") as string,
    legacySource: get("legacySource") as string,
    portSource: get("portSource") as string,
    autopsyReport: get("autopsyReport") as string,
    legacySolcVersion: get("legacySolcVersion") as string,
    legacyOptimizer: optimizer,
    ...(optimizer && { legacyOptimizerRuns: get("legacyOptimizerRuns") as number }),
    onChainRuntimeCode: get("onChainRuntimeCode") as string,
    constructorArgs: absent(get("constructorArgs")) ? DEFAULT_CONSTRUCTOR_ARGS : (get("constructorArgs") as string),
    ...(!absent(get("fuzzSeed")) && { fuzzSeed: get("fuzzSeed") as string }),
    timeoutSeconds: absent(get("timeoutSeconds")) ? DEFAULT_TIMEOUT_SECONDS : (get("timeoutSeconds") as number),
  };
  return ok(value);
}
