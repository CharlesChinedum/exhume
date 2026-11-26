/**
 * Parser for the JSON that `forge test --json` prints (design decisions 14, 15).
 * Pure: no I/O, no clock. Takes the already parsed top-level value; text output
 * is never parsed. Messages are ASCII.
 *
 * Observed shape (Foundry 1.5.1, findings 1.4):
 *   { "<file>:<contract>": { test_results: { "<test>()": {
 *       status, reason, counterexample: null | { Sequence: [originalLength, calls] } } } } }
 * `counterexample: null` means the campaign did not fail ("witness-not-failed").
 * Any other counterexample form (forge's enum has more variants) is rejected.
 */
import type { Result } from "./types.js";
import { err, ok, seanceError } from "./types.js";

export interface HandlerCall {
  funcName: string;
  signature: string;
  /** Forge's `args` field as a list. A string is wrapped; an empty string gives `[]`. */
  args: string[];
  /** Forge's `raw_args` string ("" when absent). */
  rawArgs: string;
  /** 0x hex, even length. */
  calldata: string;
  /** 0x + 40 hex. */
  sender: string;
  /** Handler address as forge gives it ("" when absent). */
  addr: string;
  contractName: string;
}

export type CounterexampleResult =
  | { kind: "none" }
  | { kind: "found"; originalLength: number; calls: HandlerCall[] };

export interface ParseOptions {
  /** Matches the full `<file>:<contract>` key or only the contract part. */
  contract?: string;
  /** Matches the test name with or without the trailing `()`. */
  test?: string;
}

export type TestStatus = "Success" | "Failure" | "Skipped";

interface Selected {
  key: string;
  test: string;
  result: Record<string, unknown>;
}

const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(message: string, details?: unknown) {
  return err(seanceError("SEANCE_FAILED", message, details));
}

const bareTest = (name: string): string => (name.endsWith("()") ? name.slice(0, -2) : name);

function select(json: unknown, opts: ParseOptions): Result<Selected> {
  if (!isObject(json)) return fail("forge JSON: top level is not an object");
  const keys = Object.keys(json).sort();
  if (keys.length === 0) return fail("forge JSON: top level is empty");
  const matches: Selected[] = [];
  for (const key of keys) {
    const entry = json[key];
    if (!isObject(entry)) return fail(`forge JSON: ["${key}"] is not an object`);
    if (opts.contract !== undefined) {
      const contractPart = key.slice(key.lastIndexOf(":") + 1);
      if (key !== opts.contract && contractPart !== opts.contract) continue;
    }
    const results = entry["test_results"];
    if (results === undefined) continue;
    if (!isObject(results)) return fail(`forge JSON: ["${key}"].test_results is not an object`);
    for (const test of Object.keys(results).sort()) {
      const matched =
        opts.test !== undefined ? bareTest(test) === bareTest(opts.test) : test.startsWith("invariant");
      if (!matched) continue;
      const result = results[test];
      if (!isObject(result)) return fail(`forge JSON: ["${key}"].test_results["${test}"] is not an object`);
      matches.push({ key, test, result });
    }
  }
  if (matches.length === 0) {
    return fail("forge JSON: no matching invariant test result found", { keys, opts });
  }
  if (matches.length > 1) {
    return fail("forge JSON: more than one matching invariant result; pass a contract/test filter", {
      matches: matches.map((m) => `${m.key}:${m.test}`),
    });
  }
  return ok(matches[0] as Selected);
}

/** Status of the selected result. Same selection and errors as `parseCounterexample`. */
export function testStatus(json: unknown, opts: ParseOptions = {}): Result<TestStatus> {
  const sel = select(json, opts);
  if (!sel.ok) return sel;
  const status = sel.value.result["status"];
  if (status !== "Success" && status !== "Failure" && status !== "Skipped") {
    return fail(`forge JSON: ${pathOf(sel.value)}.status is not Success, Failure or Skipped`);
  }
  return ok(status);
}

const pathOf = (s: Selected): string => `["${s.key}"].test_results["${s.test}"]`;

function parseCall(raw: unknown, path: string): Result<HandlerCall> {
  if (!isObject(raw)) return fail(`forge JSON: ${path} is not an object`);
  const funcName = raw["func_name"];
  if (typeof funcName !== "string" || funcName === "") {
    return fail(`forge JSON: ${path}.func_name is missing or not a non-empty string`);
  }
  const calldata = raw["calldata"];
  if (typeof calldata !== "string" || !HEX_BYTES.test(calldata)) {
    return fail(`forge JSON: ${path}.calldata is missing or not 0x hex of even length`);
  }
  const sender = raw["sender"];
  if (typeof sender !== "string" || !ADDRESS.test(sender)) {
    return fail(`forge JSON: ${path}.sender is missing or not a 0x 20-byte address`);
  }
  const optString = (field: string): Result<string> => {
    const v = raw[field];
    if (v === undefined) return ok("");
    if (typeof v !== "string") return fail(`forge JSON: ${path}.${field} is not a string`);
    return ok(v);
  };
  const signature = optString("signature");
  if (!signature.ok) return signature;
  const rawArgs = optString("raw_args");
  if (!rawArgs.ok) return rawArgs;
  const addr = optString("addr");
  if (!addr.ok) return addr;
  const contractName = optString("contract_name");
  if (!contractName.ok) return contractName;
  let args: string[];
  const a = raw["args"];
  if (a === undefined) args = [];
  else if (typeof a === "string") args = a === "" ? [] : [a];
  else if (Array.isArray(a) && a.every((x) => typeof x === "string")) args = [...(a as string[])];
  else return fail(`forge JSON: ${path}.args is not a string or an array of strings`);
  return ok({
    funcName,
    signature: signature.value,
    args,
    rawArgs: rawArgs.value,
    calldata,
    sender,
    addr: addr.value,
    contractName: contractName.value,
  });
}

/**
 * Reads the counterexample of the selected invariant result.
 * `counterexample: null` gives `{ kind: "none" }`; `Sequence: [n, calls]` gives
 * `found`. Everything else is `SEANCE_FAILED` naming the offending path.
 */
export function parseCounterexample(json: unknown, opts: ParseOptions = {}): Result<CounterexampleResult> {
  const sel = select(json, opts);
  if (!sel.ok) return sel;
  const base = pathOf(sel.value);
  const r = sel.value.result;
  if (!("counterexample" in r)) return fail(`forge JSON: ${base}.counterexample is missing`);
  const ce = r["counterexample"];
  if (ce === null) return ok({ kind: "none" });
  const cePath = `${base}.counterexample`;
  if (r["status"] !== "Failure") {
    return fail(`forge JSON: ${base}.status is not Failure but ${cePath} is not null`);
  }
  if (!isObject(ce) || !("Sequence" in ce)) {
    return fail(`forge JSON: ${cePath} is neither null nor an object with Sequence`);
  }
  const seq = ce["Sequence"];
  if (!Array.isArray(seq) || seq.length !== 2) {
    return fail(`forge JSON: ${cePath}.Sequence is not an array of length 2`);
  }
  const originalLength = seq[0];
  if (typeof originalLength !== "number" || !Number.isInteger(originalLength) || originalLength < 0) {
    return fail(`forge JSON: ${cePath}.Sequence[0] is not a non-negative integer`);
  }
  const rawCalls = seq[1];
  if (!Array.isArray(rawCalls)) return fail(`forge JSON: ${cePath}.Sequence[1] is not an array`);
  const calls: HandlerCall[] = [];
  for (let i = 0; i < rawCalls.length; i++) {
    const c = parseCall(rawCalls[i], `${cePath}.Sequence[1][${i}]`);
    if (!c.ok) return c;
    calls.push(c.value);
  }
  return ok({ kind: "found", originalLength, calls });
}
