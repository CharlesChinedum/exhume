/**
 * Classifier: the TypeScript oracle for the séance decision table.
 * `Classifier.sol` (generated) mirrors this file; both run the shared vectors.
 *
 * Pure: no clock, randomness, I/O, or mutation of inputs.
 *
 * Hex handling: a hex string is `0x` followed by an even number of hex digits
 * (so "0x" is the empty byte string). Digits are case-insensitive and values
 * are compared as lowercase, which equals comparing bytes. A value without
 * the `0x` prefix, or with odd length, is malformed.
 */
import type { CallRecord, Classification, CtorOutcome, NormLog, ObservableState } from "./types.js";

const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

/** `Panic(uint256)` selector followed by the 32-byte word 0x11: 36 bytes, 74 hex digits plus prefix. */
const PANIC_0X11 = "0x4e487b71" + "0".repeat(62) + "11";

/** Sentinel emitter meaning "the deployment itself". */
export const SELF = "SELF" as const;

export function isHex(v: unknown): v is string {
  return typeof v === "string" && HEX_RE.test(v);
}

/** True only for exactly the 36-byte `Panic(0x11)` encoding. Any other input (type, length, word) is false. */
export function isPanic0x11(revertData: unknown): boolean {
  return isHex(revertData) && revertData.toLowerCase() === PANIC_0X11;
}

/** Byte equality of two valid hex strings. */
function hexEq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// ---------------------------------------------------------------------------
// Log normalisation
// ---------------------------------------------------------------------------

export interface RawLog {
  emitter: string;
  topics: string[];
  data: string;
}

/**
 * Normalises the logs of one call on one deployment.
 * - A reverted call has no logs (Requirement 3.11): returns `[]`.
 * - An emitter equal to `deploymentAddress` (case-insensitive) becomes `"SELF"`;
 *   any other emitter is kept, lowercased.
 * - Topics and data are lowercased. Order is preserved. Input is not mutated.
 */
export function normalizeLogs(rawLogs: readonly RawLog[], deploymentAddress: string, success: boolean): NormLog[] {
  if (!success) return [];
  const self = deploymentAddress.toLowerCase();
  return rawLogs.map((l) => {
    const emitter = l.emitter.toLowerCase();
    return {
      emitter: emitter === self ? SELF : emitter,
      topics: l.topics.map((t) => t.toLowerCase()),
      data: l.data.toLowerCase(),
    };
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validLog(l: unknown): l is NormLog {
  return (
    isPlainObject(l) &&
    typeof l.emitter === "string" &&
    (l.emitter === SELF || isHex(l.emitter)) &&
    Array.isArray(l.topics) &&
    l.topics.every(isHex) &&
    isHex(l.data)
  );
}

/** A well-formed record has a boolean outcome, hex data, a log array of valid logs, and a state map of hex values. */
function validRecord(r: unknown): r is CallRecord {
  if (!isPlainObject(r)) return false;
  if (typeof r.success !== "boolean") return false;
  if (!isHex(r.data)) return false;
  if (!Array.isArray(r.logs) || !r.logs.every(validLog)) return false;
  const state = r.state;
  if (!isPlainObject(state)) return false;
  return Object.keys(state).every((k) => isHex(state[k]));
}

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

export interface ClassifyResult {
  classification: Classification;
  invalidRecord: boolean;
  /** Sorted (UTF-16 code unit order). Non-empty only for a success/success `port-bug`. */
  differingFields: string[];
}

function logsEqual(a: readonly NormLog[], b: readonly NormLog[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i]!;
    // "SELF" matches only "SELF"; any other emitter matches only the identical address.
    const emitterEq = x.emitter === SELF || y.emitter === SELF ? x.emitter === y.emitter : hexEq(x.emitter, y.emitter);
    return (
      emitterEq &&
      x.topics.length === y.topics.length &&
      x.topics.every((t, j) => hexEq(t, y.topics[j]!)) &&
      hexEq(x.data, y.data)
    );
  });
}

function diffState(a: ObservableState, b: ObservableState): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    const inA = Object.hasOwn(a, k);
    const inB = Object.hasOwn(b, k);
    if (!inA || !inB || !hexEq(a[k]!, b[k]!)) out.push(k);
  }
  return out;
}

const INVALID: ClassifyResult = { classification: "port-bug", invalidRecord: true, differingFields: [] };

/**
 * Applies the decision table. Takes `unknown` so wire/JSON data can be fed in
 * directly; anything that is not a well-formed CallRecord gives
 * `port-bug` with `invalidRecord: true` and no differing fields.
 */
export function classify(legacy: unknown, port: unknown): ClassifyResult {
  if (!validRecord(legacy) || !validRecord(port)) return { ...INVALID, differingFields: [] };

  const result = (classification: Classification, differingFields: string[] = []): ClassifyResult => ({
    classification,
    invalidRecord: false,
    differingFields,
  });

  if (!legacy.success && !port.success) {
    return result(hexEq(legacy.data, port.data) ? "match" : "reason-modernised");
  }
  if (legacy.success && !port.success) {
    return result(isPanic0x11(port.data) ? "exorcised" : "port-bug");
  }
  if (!legacy.success && port.success) return result("port-bug");

  // Both succeeded.
  const fields: string[] = [];
  if (!hexEq(legacy.data, port.data)) fields.push("returnData");
  if (!logsEqual(legacy.logs, port.logs)) fields.push("logs");
  fields.push(...diffState(legacy.state, port.state));
  if (fields.length === 0) return result("match");
  return result("port-bug", [...new Set(fields)].sort());
}

// ---------------------------------------------------------------------------
// classifyConstructors
// ---------------------------------------------------------------------------

export interface CtorClassification {
  classification: Classification;
  /** True for every outcome except both constructors succeeding (Requirements 2.6, 2.7). */
  endSeance: boolean;
  /** True when an outcome is malformed; classification is then `port-bug`. */
  invalidRecord: boolean;
  /** Set for a one-sided revert (Requirement 2.6): which deployment reverted and its revert data. */
  reverted?: { side: "legacy" | "port"; data: string };
}

function validCtor(o: unknown): o is CtorOutcome {
  return isPlainObject(o) && typeof o.success === "boolean" && isHex(o.data);
}

/**
 * Constructor outcomes. One reverts: `port-bug` (the caller reports the
 * constructor args plus `reverted.data`). Both revert: `match` if the data is
 * identical, else `reason-modernised`. Both succeed: `match`, séance continues.
 * Malformed input: `port-bug`, `invalidRecord`, séance ends.
 */
export function classifyConstructors(legacy: unknown, port: unknown): CtorClassification {
  if (!validCtor(legacy) || !validCtor(port)) {
    return { classification: "port-bug", endSeance: true, invalidRecord: true };
  }
  if (legacy.success && port.success) return { classification: "match", endSeance: false, invalidRecord: false };
  if (!legacy.success && !port.success) {
    return {
      classification: hexEq(legacy.data, port.data) ? "match" : "reason-modernised",
      endSeance: true,
      invalidRecord: false,
    };
  }
  return {
    classification: "port-bug",
    endSeance: true,
    invalidRecord: false,
    reverted: legacy.success ? { side: "port", data: port.data } : { side: "legacy", data: legacy.data },
  };
}
