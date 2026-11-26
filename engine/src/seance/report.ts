/**
 * Report_Builder, part 1 (task 9.1): record parsing, replay-tail verification, grouping, counts.
 * Pure: no clock, randomness, or I/O. Messages are ASCII.
 *
 * Follows design.md, Report_Builder, "Replay tail (decision 13)". Choices where the design is silent:
 * - `runs` must be an integer >= 1, otherwise `INVALID_INPUT`.
 * - An empty file (or only a truncated line) is a valid stream with zero records and zero counts.
 * - Unknown fields on a line are tolerated and dropped. Known fields are validated by type only
 *   (`logs` is checked to be an array, not parsed deeper).
 * - Only a last line with no trailing newline that fails JSON parsing is discarded. A last line that
 *   ends in a newline and fails parsing, or any bad line elsewhere, is `SEANCE_FAILED`.
 * - Blank lines are bad JSON lines.
 * - A setup line (`idx == -1`) may appear anywhere in the kept lines (the continuity rule exempts
 *   it); all setup lines go to `setupRecords`. The design does not require setup first.
 * - Records after an `exorcised` record in the same fuzz sequence are dropped silently (Requirement
 *   5.3), before ordinals are assigned. Setup records are never truncated.
 * - Tail verification runs on the raw lines, before the post-exorcism drop.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import reportSchema from "./schemas/seance-report.schema.json" with { type: "json" };
import { INVARIANT_DEPTH, INVARIANT_RUNS } from "./forge-std-pin.js";
import type {
  AbiFunction,
  ArithmeticSite,
  AutopsyReport,
  CallRecordWire,
  Classification,
  ClassificationCounts,
  Finding,
  FindingClassification,
  Operand,
  OrderedRecord,
  ParamSlot,
  PrecedingCall,
  RecordLine,
  Result,
  SeanceReport,
  TargetPlan,
  UnshrunkReason,
} from "./types.js";
import { CLASSIFICATIONS, err, isClassification, ok, seanceError } from "./types.js";

export interface SequenceResults {
  /** Number of fuzz sequences kept (tail excluded). */
  total: number;
  /** Sequences that contain an `exorcised` record (they end at it). */
  endedExorcised: number;
  /** `idx` of the exorcised record of each such sequence, in sequence order. */
  exorcisedAtIndex: number[];
}

export interface ParsedRecords {
  /** Kept records (setup + fuzz) in file order, with `ordinal` and `fuzzOrdinal` assigned. */
  records: OrderedRecord[];
  /** Setup records (`idx == -1`), in file order. */
  setupRecords: OrderedRecord[];
  /** Fuzz sequences in file order; each ends at its exorcised record if it has one. */
  sequences: OrderedRecord[][];
  /** Parallel to `sequences`: `idx` of the exorcised record, or `null`. */
  exorcisedAtIndex: (number | null)[];
  /** Over all kept records (setup and fuzz, tainted included). */
  counts: ClassificationCounts;
  totalCalls: number;
  setupCalls: number;
  /** Kept records with `afterDivergence == true` (already inside `counts`). */
  taintedCalls: number;
  sequenceResults: SequenceResults;
  /** What happened to the replay tail. */
  tail: { present: boolean; verified: boolean; lines: number };
}

interface ParsedLine {
  line: number; // 1-based line number in records.jsonl
  rec: RecordLine;
}

const fail = (message: string, details?: unknown): Result<never> =>
  err(seanceError("SEANCE_FAILED", message, details));

// ---------------------------------------------------------------------------
// Line parsing and validation
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseWire(v: unknown, line: number, side: "legacy" | "port"): Result<RecordLine["legacy"]> {
  if (!isObj(v)) return fail(`line ${line}: field ${side} is missing or not an object`, { line, field: side });
  const bad = (f: string, what: string): Result<never> =>
    fail(`line ${line}: field ${side}.${f} ${what}`, { line, field: `${side}.${f}` });
  if (typeof v.success !== "boolean") return bad("success", "is missing or not a boolean");
  if (typeof v.data !== "string") return bad("data", "is missing or not a string");
  if (!Array.isArray(v.logs)) return bad("logs", "is missing or not an array");
  if (typeof v.stateHash !== "string") return bad("stateHash", "is missing or not a string");
  if (v.stateFields !== undefined && !isObj(v.stateFields)) return bad("stateFields", "is not an object");
  const wire: RecordLine["legacy"] = {
    success: v.success,
    data: v.data,
    logs: v.logs as RecordLine["legacy"]["logs"],
    stateHash: v.stateHash,
  };
  if (v.stateFields !== undefined) wire.stateFields = v.stateFields as Record<string, string>;
  return ok(wire);
}

function parseLine(text: string, line: number): Result<RecordLine> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return fail(`line ${line}: invalid JSON`, { line });
  }
  if (!isObj(v)) return fail(`line ${line}: not a JSON object`, { line });
  const bad = (f: string, what: string): Result<never> => fail(`line ${line}: field ${f} ${what}`, { line, field: f });

  if (typeof v.idx !== "number" || !Number.isInteger(v.idx) || v.idx < -1) {
    return bad("idx", "is missing or not an integer >= -1");
  }
  for (const f of ["function", "selector", "calldata", "sender", "value"] as const) {
    if (typeof v[f] !== "string") return bad(f, "is missing or not a string");
  }
  const legacy = parseWire(v.legacy, line, "legacy");
  if (!legacy.ok) return legacy;
  const port = parseWire(v.port, line, "port");
  if (!port.ok) return port;
  if (!isClassification(v.classification)) {
    return bad("classification", `is missing or not one of ${CLASSIFICATIONS.join(", ")}`);
  }
  if (!Array.isArray(v.differingFields) || !v.differingFields.every((x) => typeof x === "string")) {
    return bad("differingFields", "is missing or not an array of strings");
  }
  if (typeof v.invalidRecord !== "boolean") return bad("invalidRecord", "is missing or not a boolean");
  if (typeof v.afterDivergence !== "boolean") return bad("afterDivergence", "is missing or not a boolean");

  return ok({
    idx: v.idx,
    function: v.function as string,
    selector: v.selector as string,
    calldata: v.calldata as string,
    sender: v.sender as string,
    value: v.value as string,
    legacy: legacy.value,
    port: port.value,
    classification: v.classification,
    differingFields: v.differingFields as string[],
    invalidRecord: v.invalidRecord,
    afterDivergence: v.afterDivergence,
  });
}

// ---------------------------------------------------------------------------
// Tail verification
// ---------------------------------------------------------------------------

/** Canonical JSON (sorted object keys); `undefined` prints as `<absent>`. */
function canon(v: unknown): string {
  if (v === undefined) return "<absent>";
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

const clip = (s: string): string => (s.length > 200 ? `${s.slice(0, 200)}...(${s.length} chars)` : s);

const TOP_FIELDS = ["idx", "function", "selector", "calldata", "sender", "value"] as const;
const WIRE_FIELDS = ["success", "data", "logs", "stateHash", "stateFields"] as const;
const TAIL_FIELDS = ["classification", "differingFields", "invalidRecord", "afterDivergence"] as const;

/** First differing field name between two parsed lines (everything but `ordinal`), or undefined. */
function firstDifference(
  a: RecordLine,
  b: RecordLine,
): { field: string; expected: unknown; actual: unknown } | undefined {
  for (const f of TOP_FIELDS) {
    if (a[f] !== b[f]) return { field: f, expected: a[f], actual: b[f] };
  }
  for (const side of ["legacy", "port"] as const) {
    for (const f of WIRE_FIELDS) {
      if (canon(a[side][f]) !== canon(b[side][f])) {
        return { field: `${side}.${f}`, expected: a[side][f], actual: b[side][f] };
      }
    }
  }
  for (const f of TAIL_FIELDS) {
    if (canon(a[f]) !== canon(b[f])) return { field: f, expected: a[f], actual: b[f] };
  }
  return undefined;
}

function verifyTail(expected: ParsedLine[], tail: ParsedLine[]): Result<void> {
  const n = Math.min(expected.length, tail.length);
  for (let i = 0; i < n; i++) {
    const d = firstDifference(expected[i]!.rec, tail[i]!.rec);
    if (d) {
      return fail(
        `replay tail mismatch at line ${tail[i]!.line}: field ${d.field} differs, expected ${clip(canon(d.expected))}, actual ${clip(canon(d.actual))}`,
        { line: tail[i]!.line, field: d.field, expected: d.expected, actual: d.actual },
      );
    }
  }
  if (tail.length < expected.length) {
    const line = tail[tail.length - 1]!.line + 1;
    return fail(
      `replay tail mismatch at line ${line}: missing line (tail has ${tail.length} lines, last kept sequence has ${expected.length})`,
      { line, field: "missing line" },
    );
  }
  if (tail.length > expected.length) {
    const line = tail[expected.length]!.line;
    return fail(
      `replay tail mismatch at line ${line}: extra line (tail has ${tail.length} lines, last kept sequence has ${expected.length})`,
      { line, field: "extra line" },
    );
  }
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// parseRecords
// ---------------------------------------------------------------------------

export function emptyCounts(): ClassificationCounts {
  return { match: 0, "reason-modernised": 0, exorcised: 0, "port-bug": 0 };
}

/**
 * Parses `records.jsonl`, strips and verifies the replay tail, validates idx continuity, and groups
 * and counts the kept records. `runs` is `INVARIANT_RUNS` in production.
 */
export function parseRecords(jsonl: string, runs: number): Result<ParsedRecords> {
  if (!Number.isInteger(runs) || runs < 1) {
    return err(seanceError("INVALID_INPUT", `runs must be an integer >= 1, got ${String(runs)}`));
  }

  // 1. Split into lines. A last line without a trailing newline that fails JSON parse is truncated.
  const texts = jsonl.split("\n");
  const endsWithNewline = texts[texts.length - 1] === "";
  if (endsWithNewline) texts.pop();
  const parsed: ParsedLine[] = [];
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]!;
    const isLast = i === texts.length - 1;
    const r = parseLine(text, i + 1);
    if (!r.ok) {
      if (isLast && !endsWithNewline) {
        let jsonOk = true;
        try {
          JSON.parse(text);
        } catch {
          jsonOk = false;
        }
        if (!jsonOk) continue; // truncated last line
      }
      return r;
    }
    parsed.push({ line: i + 1, rec: r.value });
  }

  // 2. Sequence starts (idx == 0) and the tail boundary.
  const starts: number[] = [];
  parsed.forEach((p, i) => {
    if (p.rec.idx === 0) starts.push(i);
  });
  const tailStart = starts.length > runs ? starts[runs]! : parsed.length;
  const keptLines = parsed.slice(0, tailStart);
  const tailLines = parsed.slice(tailStart);

  // 3. idx continuity on the kept lines; setup lines are exempt.
  let prev: number | undefined;
  for (const p of keptLines) {
    const idx = p.rec.idx;
    if (idx === -1) continue;
    const expected = prev === undefined ? 0 : prev + 1;
    if (!(idx === 0 || (prev !== undefined && idx === expected))) {
      return fail(`line ${p.line}: idx ${idx} breaks sequence continuity, expected ${expected}`, {
        line: p.line,
        idx,
        expected,
      });
    }
    prev = idx;
  }

  // 4. Tail verification against the last kept sequence.
  if (tailLines.length > 0) {
    const lastStart = starts[runs - 1]!;
    const lastSeq = keptLines.slice(lastStart).filter((p) => p.rec.idx !== -1);
    const v = verifyTail(lastSeq, tailLines);
    if (!v.ok) return v;
  }

  // 5. Group, truncating each fuzz sequence at its exorcised record.
  const kept: RecordLine[] = [];
  const keptSeqIndex: number[] = []; // sequence number per kept record, -1 for setup
  const exorcisedAt: (number | null)[] = [];
  let seq = -1;
  let seqDone = false;
  for (const { rec } of keptLines) {
    if (rec.idx === -1) {
      kept.push(rec);
      keptSeqIndex.push(-1);
      continue;
    }
    if (rec.idx === 0) {
      seq++;
      seqDone = false;
      exorcisedAt.push(null);
    }
    if (seqDone) continue; // after an exorcised record (Requirement 5.3)
    kept.push(rec);
    keptSeqIndex.push(seq);
    if (rec.classification === "exorcised") {
      seqDone = true;
      exorcisedAt[seq] = rec.idx;
    }
  }

  // 6. Ordinals, grouping, counts.
  const records: OrderedRecord[] = [];
  const setupRecords: OrderedRecord[] = [];
  const sequences: OrderedRecord[][] = exorcisedAt.map(() => []);
  const counts = emptyCounts();
  let fuzzOrdinal = 0;
  let taintedCalls = 0;
  kept.forEach((rec, i) => {
    const o: OrderedRecord = { ...rec, ordinal: i + 1 };
    if (rec.idx >= 0) o.fuzzOrdinal = ++fuzzOrdinal;
    records.push(o);
    if (keptSeqIndex[i] === -1) setupRecords.push(o);
    else sequences[keptSeqIndex[i]!]!.push(o);
    counts[rec.classification as Classification]++;
    if (rec.afterDivergence) taintedCalls++;
  });

  const ended = exorcisedAt.filter((x): x is number => x !== null);
  return ok({
    records,
    setupRecords,
    sequences,
    exorcisedAtIndex: exorcisedAt,
    counts,
    totalCalls: records.length,
    setupCalls: setupRecords.length,
    taintedCalls,
    sequenceResults: { total: sequences.length, endedExorcised: ended.length, exorcisedAtIndex: ended },
    tail: { present: tailLines.length > 0, verified: tailLines.length > 0, lines: tailLines.length },
  });
}

// ---------------------------------------------------------------------------
// Task 9.2: finding selection, dispositions, and the reported choice
// ---------------------------------------------------------------------------
//
// Choices where the design is silent (see also the 9.2 report):
// - `selectFindingPairs(parsed)` takes the `ParsedRecords` of `parseRecords` and returns one flat,
//   sorted list. The design's `{ setup, selected, overCap }` split is made by `assignDispositions`.
// - A `Pair` also carries `preceding`: the earlier records of the representative's own fuzz sequence
//   (empty for a setup pair). Setup calls are not preceding calls of a fuzz finding, because every
//   generated contract re-runs the same setup in `setUp`.
// - `assignDispositions` has no cap option: the cap is the fixed `WITNESS_CAP` of 10, matching the
//   literal `shrinking.witnessCap: 10` of the report type.
// - A selected pair that is not finished and has no deadline stays `shrink` (pending). Pending pairs
//   are not counted, so `pairsFound` is the sum of the four counted groups and equals `pairs.length`
//   only when nothing is pending.

export const WITNESS_CAP = 10;

export interface Pair {
  function: string;
  classification: FindingClassification;
  /** First untainted record of the pair, by ordinal. */
  first: OrderedRecord;
  /** The representative is a setup record (`idx == -1`). */
  setup: boolean;
  /** Earlier records of the representative's fuzz sequence, in order. Empty for a setup pair. */
  preceding: OrderedRecord[];
}

/** Stable key of a (function, Classification) pair. Function names contain no `|`. */
export function pairKey(p: { function: string; classification: string }): string {
  return `${p.function}|${p.classification}`;
}

export function selectFindingPairs(parsed: ParsedRecords): Pair[] {
  const firsts = new Map<string, OrderedRecord>();
  for (const r of parsed.records) {
    if (r.afterDivergence) continue;
    if (r.classification !== "exorcised" && r.classification !== "port-bug") continue;
    const key = pairKey(r);
    const seen = firsts.get(key);
    if (seen === undefined || r.ordinal < seen.ordinal) firsts.set(key, r);
  }
  const precedingOf = new Map<number, OrderedRecord[]>(); // record ordinal -> earlier records of its sequence
  for (const seq of parsed.sequences) {
    seq.forEach((r, i) => precedingOf.set(r.ordinal, seq.slice(0, i)));
  }
  const pairs: Pair[] = [...firsts.values()].map((first) => ({
    function: first.function,
    classification: first.classification as FindingClassification,
    first,
    setup: first.idx === -1,
    preceding: first.idx === -1 ? [] : (precedingOf.get(first.ordinal) ?? []),
  }));
  const group = (p: Pair): number => (p.setup ? 0 : p.classification === "exorcised" ? 1 : 2);
  return pairs.sort((a, b) => group(a) - group(b) || a.first.ordinal - b.first.ordinal);
}

/** What the Runner learned about one pair in phases 2 and 3. */
export interface ShrinkOutcome {
  /** Phase 2 result: the witness campaign failed (found a counterexample) or passed. */
  witness: "failed" | "not-failed";
  /** Pre-shrink handler-call count (`Sequence[0]`), for a failed witness. */
  originalLength?: number;
  /**
   * Phase 3 result: the replay records of the shrunk sequence. `record` is the last record with the
   * selected function and `afterDivergence = false` (absent if none); `preceding` are the earlier
   * records of the replay sequence.
   */
  replay?: { record?: RecordLine; preceding: RecordLine[] };
}

/** Keyed by `pairKey`. */
export type ShrinkOutcomes = Map<string, ShrinkOutcome>;

export interface PairProgress {
  /** Pair keys whose witness campaign completed. */
  witnessDone: Set<string>;
  /** Pair keys whose replay completed. */
  replayDone: Set<string>;
  deadlineReached: boolean;
  /** Results for completed phases. */
  outcomes: ShrinkOutcomes;
}

export type DispositionKind =
  | "setup"
  | "over-cap"
  | "shrink" // selected, not finished, no deadline: still to do
  | "shrunk-confirmed"
  | "witness-not-failed"
  | "replay-mismatch"
  | "deadline";

export interface PairDisposition {
  pair: Pair;
  disposition: DispositionKind;
  outcome: "shrunk" | "unshrunk" | "pending";
  unshrunkReason?: UnshrunkReason;
  /** Present for `shrunk-confirmed`: the confirmed phase outcome. */
  shrink?: ShrinkOutcome;
}

export type ShrinkingCounts = SeanceReport["shrinking"];

const UNSHRUNK: Record<"setup" | "over-cap" | "witness-not-failed" | "replay-mismatch" | "deadline", UnshrunkReason> = {
  setup: "setup",
  "over-cap": "witness-cap",
  "witness-not-failed": "witness-not-failed",
  "replay-mismatch": "replay-mismatch",
  deadline: "deadline",
};

function dispose(pair: Pair, kind: DispositionKind, shrink?: ShrinkOutcome): PairDisposition {
  if (kind === "shrink") return { pair, disposition: kind, outcome: "pending" };
  if (kind === "shrunk-confirmed") return { pair, disposition: kind, outcome: "shrunk", shrink: shrink! };
  return { pair, disposition: kind, outcome: "unshrunk", unshrunkReason: UNSHRUNK[kind] };
}

/**
 * Gives every pair exactly one disposition, in the order of `pairs`. Without `progress` (or before a
 * phase finishes and with no deadline) selected pairs are `shrink`. Never throws on a deadline.
 */
export function assignDispositions(
  pairs: Pair[],
  progress?: PairProgress,
): { dispositions: PairDisposition[]; shrinking: ShrinkingCounts } {
  let fuzzSeen = 0;
  const dispositions = pairs.map((pair): PairDisposition => {
    if (pair.setup) return dispose(pair, "setup");
    if (fuzzSeen++ >= WITNESS_CAP) return dispose(pair, "over-cap");
    const key = pairKey(pair);
    const out = progress?.outcomes.get(key);
    if (progress?.witnessDone.has(key) && out !== undefined) {
      if (out.witness === "not-failed") return dispose(pair, "witness-not-failed");
      if (progress.replayDone.has(key) && out.replay !== undefined) {
        return out.replay.record?.classification === pair.classification
          ? dispose(pair, "shrunk-confirmed", out)
          : dispose(pair, "replay-mismatch");
      }
    }
    return dispose(pair, progress?.deadlineReached ? "deadline" : "shrink");
  });
  const n = (k: DispositionKind): number => dispositions.filter((d) => d.disposition === k).length;
  const pairsSetup = n("setup");
  const pairsShrunk = n("shrunk-confirmed");
  const pairsUnshrunk = n("witness-not-failed") + n("replay-mismatch") + n("deadline");
  const pairsOverCap = n("over-cap");
  return {
    dispositions,
    shrinking: {
      witnessCap: 10,
      pairsFound: pairsSetup + pairsShrunk + pairsUnshrunk + pairsOverCap,
      pairsSetup,
      pairsShrunk,
      pairsUnshrunk,
      pairsOverCap,
      deadlineReached: progress?.deadlineReached ?? false,
    },
  };
}

const toPreceding = (r: RecordLine): PrecedingCall => ({
  function: r.function,
  calldata: r.calldata,
  sender: r.sender,
  value: r.value,
});

/**
 * The sequence to report for a finalized disposition (Requirements 8.3, 8.9). A confirmed shrink is
 * built from the replay records, with `originalLength`. Every other disposition reports the original
 * sequence from the discovery records, `unshrunk: true`, the reason, and the original Classification.
 * `site` is not set here. Throws on a `shrink` (pending) disposition, a caller error.
 */
export function chooseReported(d: PairDisposition): Finding {
  if (d.disposition === "shrink") throw new Error("chooseReported: pair is still pending");
  const { pair } = d;
  const confirmed = d.disposition === "shrunk-confirmed" ? d.shrink!.replay!.record! : undefined;
  const source: RecordLine = confirmed ?? pair.first;
  const preceding = confirmed ? d.shrink!.replay!.preceding : pair.preceding;
  const base = {
    function: pair.function,
    calldata: source.calldata,
    sender: source.sender,
    value: source.value,
    precedingCalls: preceding.map(toPreceding),
  };
  const classPart =
    pair.classification === "port-bug"
      ? {
          classification: "port-bug" as const,
          legacy: source.legacy,
          port: source.port,
          differingFields: [...source.differingFields],
        }
      : { classification: "exorcised" as const };
  const shrinkPart = confirmed
    ? { originalLength: d.shrink!.originalLength ?? preceding.length + 1 }
    : { unshrunk: true as const, unshrunkReason: d.unshrunkReason! };
  return { ...base, ...classPart, ...shrinkPart } as Finding;
}

// ---------------------------------------------------------------------------
// Task 9.3: report construction, validation, serialization, atomic writing
// ---------------------------------------------------------------------------
//
// Choices where the design is silent or differs (see also the 9.3 report):
// - `buildReport` takes one args object. It needs the autopsy report (operators, operand types and
//   source locations of the sites) and the ABI (operand name -> parameter index) next to the TargetPlan,
//   because the plan alone carries slots but neither operators nor locations.
// - Site attribution (Requirements 7.5, 7.6) follows the task text, not the design's "exactly one site
//   whose Targeted_Value appears" sentence: the first site of the exorcised function, in autopsy order,
//   whose operator overflows (unchecked 2^N semantics) on the operands decoded from the reported
//   calldata. N is the width of the narrowest operand type, as in the Input_Generator (Req 6.6). A site is
//   skipped when an operand is unknown, signed, or has no slot in the plan, or its calldata word is out of
//   range. When no site overflows the finding gets `site: "unattributed"`.
// - A pending disposition (`shrink`, no deadline, not finished) makes `buildReport` throw: the caller
//   must finalize dispositions first (same contract as `chooseReported`).
// - Findings keep the order of the dispositions (setup pairs, then exorcised pairs, then port-bug pairs,
//   each by first ordinal); the design does not ask for a different sort.
// - `validateReport` returns `SEANCE_FAILED` (the error union has no report-specific code) with the
//   violations in `details`.
// - The report file is `graveyard/<name>/seance-report.json` (design architecture and acceptance runner).

export const REPORT_FILE_NAME = "seance-report.json";

type SkippedFunctionEntry = SeanceReport["skippedFunctions"][number];

export interface BuildReportArgs {
  contract: string;
  /** Passed through unchanged (decision 16: best effort). */
  seed: string;
  /** Default `INVARIANT_RUNS`. */
  runs?: number;
  /** Default `INVARIANT_DEPTH`. */
  depth?: number;
  parsed: ParsedRecords;
  /** The result of `assignDispositions`; no disposition may be pending. */
  dispositions: ReturnType<typeof assignDispositions>;
  autopsy: AutopsyReport;
  abi: AbiFunction[];
  plan: TargetPlan;
  /** From the generator (`computeSkippedFunctions` / `generateProject`). Order and duplicates are normalized here. */
  skippedFunctions: readonly SkippedFunctionEntry[];
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// --- site attribution ------------------------------------------------------

const WORD_HEX = 64;

/** The 32-byte word at byte offset `byteOffset` of `hex` (0x-prefixed), as a bigint. */
function wordAt(hex: string, byteOffset: number): bigint | undefined {
  const start = 2 + byteOffset * 2;
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || start + WORD_HEX > hex.length) return undefined;
  const w = hex.slice(start, start + WORD_HEX);
  return /^[0-9a-fA-F]{64}$/.test(w) ? BigInt(`0x${w}`) : undefined;
}

function intWidth(type: string): number | undefined {
  const m = /^u?int(\d+)?$/.exec(type);
  if (!m) return undefined;
  return m[1] === undefined ? 256 : Number(m[1]);
}

/** Solidity-style overflow check for one operator on unsigned operands, `M = 2^N`. */
function overflows(op: ArithmeticSite["operator"], a: bigint, b: bigint, m: bigint): boolean {
  switch (op) {
    case "+":
      return a + b >= m;
    case "-":
      return a < b;
    case "*":
      return a * b >= m;
    case "**": {
      if (a <= 1n || b === 0n) return false;
      let r = 1n;
      for (let i = 0n; i < b; i++) {
        r *= a;
        if (r >= m) return true; // a >= 2, so this exits within N iterations
      }
      return false;
    }
  }
}

function pickFunction(site: ArithmeticSite, abi: AbiFunction[]): AbiFunction | undefined {
  const candidates = abi.filter((f) => f.type === "function" && f.name === site.function);
  const names = site.operands.flatMap((o) => (o.kind === "param" || o.kind === "arrayLength" ? [o.name] : []));
  return candidates.find((f) => names.every((n) => f.inputs.some((p) => p.name === n))) ?? candidates[0];
}

/** Value of an operand in `calldata`, or undefined when it cannot be decoded. */
function operandValue(op: Operand, fn: AbiFunction, slots: ParamSlot[], calldata: string): bigint | undefined {
  if (op.kind === "known") {
    try {
      return BigInt(op.value);
    } catch {
      return undefined;
    }
  }
  if (op.kind === "unknown") return undefined;
  const paramIndex = fn.inputs.findIndex((p) => p.name === op.name);
  const encoding = op.kind === "param" ? "static" : "dynamicArrayLength";
  const slot = slots.find((s) => s.paramIndex === paramIndex && s.encoding === encoding);
  if (slot === undefined) return undefined;
  if (slot.encoding === "static") {
    const v = wordAt(calldata, slot.headOffset);
    const w = intWidth(op.type);
    return v === undefined || w === undefined ? v : v & ((1n << BigInt(w)) - 1n);
  }
  // Head word = offset of the tail from the start of the arguments (byte 4); the tail starts with the length.
  const offset = wordAt(calldata, slot.headOffset);
  if (offset === undefined || offset > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return wordAt(calldata, 4 + Number(offset));
}

/** The first site (autopsy order) of `fnName` whose arithmetic overflows on `calldata`, else "unattributed". */
export function attributeSite(
  fnName: string,
  calldata: string,
  autopsy: AutopsyReport,
  abi: AbiFunction[],
  plan: TargetPlan,
): { id: string; location: ArithmeticSite["location"] } | "unattributed" {
  for (const site of autopsy.sites) {
    if (site.function !== fnName) continue;
    const fn = pickFunction(site, abi);
    const planSite = plan.sites.find((p) => p.siteId === site.id);
    if (fn === undefined || planSite === undefined) continue;
    if (site.operands.some((o) => /^int/.test(o.type))) continue; // signed: not attributed
    const slots = planSite.entries.flatMap((e) => e.assignments.map((a) => a.slot));
    const a = operandValue(site.operands[0], fn, slots, calldata);
    const b = operandValue(site.operands[1], fn, slots, calldata);
    if (a === undefined || b === undefined) continue;
    const widths = site.operands.map((o) => intWidth(o.type)).filter((w): w is number => w !== undefined);
    const n = widths.length > 0 ? Math.min(...widths) : 256;
    if (overflows(site.operator, a, b, 1n << BigInt(n))) {
      return { id: site.id, location: { ...site.location } };
    }
  }
  return "unattributed";
}

// --- buildReport -----------------------------------------------------------

export function buildReport(args: BuildReportArgs): SeanceReport {
  const { parsed, autopsy, abi, plan } = args;
  const exorcisms: Finding[] = [];
  const portBugs: Finding[] = [];
  for (const d of args.dispositions.dispositions) {
    const f = chooseReported(d); // throws on a pending disposition
    if (f.classification === "port-bug") {
      portBugs.push(f);
    } else {
      exorcisms.push({ ...f, site: attributeSite(f.function, f.calldata, autopsy, abi, plan) });
    }
  }

  const skipped = new Map<string, SkippedFunctionEntry>();
  for (const s of args.skippedFunctions) skipped.set(s.name, { name: s.name, reason: "stack" });
  const skippedFunctions = [...skipped.values()].sort((a, b) => cmpStr(a.name, b.name));

  const unreachable = new Set<string>();
  for (const p of plan.sites) if (p.unreachable) unreachable.add(p.siteId);
  for (const s of autopsy.sites) if (skipped.has(s.function)) unreachable.add(s.id);
  const unreachableSites: string[] = [];
  for (const s of autopsy.sites) {
    if (unreachable.has(s.id) && !unreachableSites.includes(s.id)) unreachableSites.push(s.id);
  }

  return {
    schemaVersion: "1",
    contract: args.contract,
    seed: args.seed,
    runs: args.runs ?? INVARIANT_RUNS,
    depth: args.depth ?? INVARIANT_DEPTH,
    totalCalls: parsed.totalCalls,
    counts: { ...parsed.counts },
    taintedCalls: parsed.taintedCalls,
    setupCalls: parsed.setupCalls,
    exorcisms,
    portBugs,
    sequenceResults: {
      total: parsed.sequenceResults.total,
      endedExorcised: parsed.sequenceResults.endedExorcised,
      exorcisedAtIndex: [...parsed.sequenceResults.exorcisedAtIndex],
    },
    shrinking: { ...args.dispositions.shrinking },
    unreachableSites,
    skippedFunctions,
  };
}

// --- validateReport --------------------------------------------------------

const validateSchema: ValidateFunction = new Ajv2020.default({
  allErrors: true,
  strict: true,
  strictRequired: true,
}).compile(reportSchema as object);

function schemaViolations(errors: ErrorObject[]): string[] {
  return errors.map((e) => `${e.instancePath === "" ? "/" : e.instancePath} ${e.message ?? "is invalid"}`).sort(cmpStr);
}

/** Checks JSON Schema cannot express. Assumes the schema already passed. */
function semanticViolations(r: SeanceReport): string[] {
  const v: string[] = [];
  const sum = CLASSIFICATIONS.reduce((n, c) => n + r.counts[c], 0);
  if (sum !== r.totalCalls) v.push(`counts sum to ${sum} but totalCalls is ${r.totalCalls}`);
  if (r.taintedCalls > r.totalCalls) v.push(`taintedCalls ${r.taintedCalls} exceeds totalCalls ${r.totalCalls}`);
  if (r.setupCalls > r.totalCalls) v.push(`setupCalls ${r.setupCalls} exceeds totalCalls ${r.totalCalls}`);

  const s = r.shrinking;
  const others = s.pairsSetup + s.pairsShrunk + s.pairsUnshrunk + s.pairsOverCap;
  if (s.pairsFound !== others) {
    v.push(`shrinking.pairsFound is ${s.pairsFound} but pairsSetup + pairsShrunk + pairsUnshrunk + pairsOverCap is ${others}`);
  }

  for (let i = 0; i < r.skippedFunctions.length; i++) {
    const cur = r.skippedFunctions[i]!.name;
    const prev = i > 0 ? r.skippedFunctions[i - 1]!.name : undefined;
    if (prev === undefined) continue;
    if (cur === prev) v.push(`skippedFunctions has duplicate name ${JSON.stringify(cur)}`);
    else if (cmpStr(prev, cur) > 0) v.push(`skippedFunctions is not sorted by name: ${JSON.stringify(prev)} before ${JSON.stringify(cur)}`);
  }
  const names = r.skippedFunctions.map((f) => f.name);
  if (new Set(names).size !== names.length && !v.some((m) => m.includes("duplicate"))) {
    v.push("skippedFunctions has duplicate names");
  }

  const seen = new Set<string>();
  const check = (list: Finding[], where: "exorcisms" | "portBugs", cls: FindingClassification): void => {
    list.forEach((f, i) => {
      if (f.classification !== cls) v.push(`${where}[${i}] has classification ${f.classification}, expected ${cls}`);
      const key = pairKey(f);
      if (seen.has(key)) v.push(`${where}[${i}] repeats the finding for function ${f.function} and classification ${f.classification}`);
      seen.add(key);
      if (cls === "exorcised" && f.site === undefined) v.push(`${where}[${i}] has no site (use "unattributed" when none applies)`);
    });
  };
  check(r.exorcisms, "exorcisms", "exorcised");
  check(r.portBugs, "portBugs", "port-bug");
  return v;
}

export function validateReport(report: unknown): Result<SeanceReport> {
  if (!validateSchema(report)) {
    const violations = schemaViolations(validateSchema.errors ?? []);
    return err(seanceError("SEANCE_FAILED", `Seance report does not match the schema: ${violations.join("; ")}`, { violations }));
  }
  const r = report as SeanceReport;
  const violations = semanticViolations(r);
  if (violations.length > 0) {
    return err(seanceError("SEANCE_FAILED", `Seance report is inconsistent: ${violations.join("; ")}`, { violations }));
  }
  return ok(r);
}

// --- serialization ---------------------------------------------------------

function orderWire(w: CallRecordWire): Record<string, unknown> {
  const o: Record<string, unknown> = {
    success: w.success,
    data: w.data,
    logs: w.logs.map((l) => ({ emitter: l.emitter, topics: [...l.topics], data: l.data })),
    stateHash: w.stateHash,
  };
  if (w.stateFields !== undefined) {
    o.stateFields = Object.fromEntries(Object.keys(w.stateFields).sort(cmpStr).map((k) => [k, w.stateFields![k]]));
  }
  return o;
}

function orderFinding(f: Finding): Record<string, unknown> {
  const o: Record<string, unknown> = {
    function: f.function,
    classification: f.classification,
    calldata: f.calldata,
    sender: f.sender,
    value: f.value,
    precedingCalls: f.precedingCalls.map((p) => ({
      function: p.function,
      calldata: p.calldata,
      sender: p.sender,
      value: p.value,
    })),
  };
  if (f.originalLength !== undefined) o.originalLength = f.originalLength;
  if (f.unshrunk !== undefined) o.unshrunk = f.unshrunk;
  if (f.unshrunkReason !== undefined) o.unshrunkReason = f.unshrunkReason;
  if (f.site !== undefined) {
    o.site =
      f.site === "unattributed"
        ? f.site
        : { id: f.site.id, location: { file: f.site.location.file, line: f.site.location.line, column: f.site.location.column } };
  }
  if (f.legacy !== undefined) o.legacy = orderWire(f.legacy);
  if (f.port !== undefined) o.port = orderWire(f.port);
  if (f.differingFields !== undefined) o.differingFields = [...f.differingFields];
  return o;
}

/** Canonical form: fixed key order (the type and schema order), 2-space indent, one trailing LF. */
export function serializeReport(report: SeanceReport): string {
  const s = report.shrinking;
  const ordered = {
    schemaVersion: report.schemaVersion,
    contract: report.contract,
    seed: report.seed,
    runs: report.runs,
    depth: report.depth,
    totalCalls: report.totalCalls,
    counts: {
      match: report.counts.match,
      "reason-modernised": report.counts["reason-modernised"],
      exorcised: report.counts.exorcised,
      "port-bug": report.counts["port-bug"],
    },
    taintedCalls: report.taintedCalls,
    setupCalls: report.setupCalls,
    exorcisms: report.exorcisms.map(orderFinding),
    portBugs: report.portBugs.map(orderFinding),
    sequenceResults: {
      total: report.sequenceResults.total,
      endedExorcised: report.sequenceResults.endedExorcised,
      exorcisedAtIndex: [...report.sequenceResults.exorcisedAtIndex],
    },
    shrinking: {
      witnessCap: s.witnessCap,
      pairsFound: s.pairsFound,
      pairsSetup: s.pairsSetup,
      pairsShrunk: s.pairsShrunk,
      pairsUnshrunk: s.pairsUnshrunk,
      pairsOverCap: s.pairsOverCap,
      deadlineReached: s.deadlineReached,
    },
    unreachableSites: [...report.unreachableSites],
    skippedFunctions: report.skippedFunctions.map((f) => ({ name: f.name, reason: f.reason })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function parseReport(text: string): Result<SeanceReport> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return err(seanceError("SEANCE_FAILED", `Seance report is not valid JSON: ${(e as Error).message}`));
  }
  return validateReport(v);
}

// --- atomic write ----------------------------------------------------------

/** Graveyard directory names: letters, digits, `_` and `-`; no dots, so no `..`, and no path separators. */
const GRAVEYARD_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Writes `<graveyardRoot>/<name>/seance-report.json` through a temp file in the same directory and `rename`.
 * An invalid name gives `INVALID_INPUT`, an invalid report the `validateReport` error (nothing is written in
 * either case), and any I/O failure `REPORT_WRITE_FAILED`, with an existing report left unchanged and the temp
 * file removed.
 */
export async function writeReportAtomic(
  graveyardRoot: string,
  name: string,
  report: SeanceReport,
): Promise<Result<{ path: string }>> {
  if (typeof name !== "string" || !GRAVEYARD_NAME.test(name)) {
    return err(seanceError("INVALID_INPUT", `Invalid graveyard directory name ${JSON.stringify(name)}: use letters, digits, "_" and "-" only`));
  }
  const valid = validateReport(report);
  if (!valid.ok) return valid;
  const dir = join(graveyardRoot, name);
  const target = join(dir, REPORT_FILE_NAME);
  const tmp = join(dir, `.${REPORT_FILE_NAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let created = false;
  try {
    const text = serializeReport(valid.value);
    await mkdir(dir, { recursive: true });
    const fh = await open(tmp, "wx");
    created = true;
    try {
      await fh.writeFile(text, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, target);
    created = false;
    try {
      const dh = await open(dir, "r");
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    } catch {
      // Directory fsync is best effort (not supported everywhere); the rename already happened.
    }
    return ok({ path: target });
  } catch (e) {
    if (created) await unlink(tmp).catch(() => undefined);
    const code = (e as NodeJS.ErrnoException).code;
    return err(
      seanceError("REPORT_WRITE_FAILED", `Could not write ${target}: ${(e as Error).message}`, {
        path: target,
        ...(code !== undefined && { errno: code }),
      }),
    );
  }
}
