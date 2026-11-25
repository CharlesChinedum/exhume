/**
 * Shared types and error model for the Séance engine.
 *
 * One module on purpose: later tasks import from here and do not edit each
 * other's types. Types plus a few trivial helpers only; no business logic.
 * Field names and shapes follow `.kiro/specs/seance-engine/design.md`.
 */

// ---------------------------------------------------------------------------
// Closed sets
// ---------------------------------------------------------------------------

/** Séance divergence classes (Requirement 4). */
export const CLASSIFICATIONS = ["match", "reason-modernised", "exorcised", "port-bug"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/** Why a finding is reported with its original, unshrunk sequence (Requirement 8). */
export const UNSHRUNK_REASONS = [
  "witness-not-failed",
  "replay-mismatch",
  "witness-cap",
  "deadline",
  "setup",
] as const;
export type UnshrunkReason = (typeof UNSHRUNK_REASONS)[number];

/** Every error code in the design's error table and Entry_Point list. */
export const SEANCE_ERROR_CODES = [
  "MISSING_INPUT",
  "INVALID_INPUT",
  "AUTOPSY_REJECTED",
  "SOLC_MISSING",
  "BUILD_FAILED",
  "BYTECODE_MISMATCH",
  "TIMEOUT",
  "HANDLER_FAULT",
  "REPORT_WRITE_FAILED",
  "ACCEPTANCE_FAILED",
  "SEANCE_FAILED",
] as const;
export type SeanceErrorCode = (typeof SEANCE_ERROR_CODES)[number];

/** Phases in which a deadline raises `TIMEOUT` (never witness or replay). */
export const TIMEOUT_PHASES = ["build", "discovery"] as const;
export type TimeoutPhase = (typeof TIMEOUT_PHASES)[number];

/** Findings are only ever one of these two classes. */
export type FindingClassification = Extract<Classification, "exorcised" | "port-bug">;

export function isClassification(v: unknown): v is Classification {
  return typeof v === "string" && (CLASSIFICATIONS as readonly string[]).includes(v);
}
export function isUnshrunkReason(v: unknown): v is UnshrunkReason {
  return typeof v === "string" && (UNSHRUNK_REASONS as readonly string[]).includes(v);
}
export function isSeanceErrorCode(v: unknown): v is SeanceErrorCode {
  return typeof v === "string" && (SEANCE_ERROR_CODES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Errors and Result
// ---------------------------------------------------------------------------

export type ClassificationCounts = Record<Classification, number>;

interface SeanceErrorBase {
  message: string;
  details?: unknown;
}

/** Codes that carry neither `phase` nor `partialCounts`. */
export type PlainSeanceErrorCode = Exclude<SeanceErrorCode, "TIMEOUT" | "HANDLER_FAULT">;

/**
 * Union keyed on `code`. `partialCounts` is optional (as in the design's type
 * sketch) on TIMEOUT/discovery and HANDLER_FAULT, and excluded everywhere else.
 */
export type SeanceError = SeanceErrorBase &
  (
    | { code: "TIMEOUT"; phase: "build"; partialCounts?: never }
    | { code: "TIMEOUT"; phase: "discovery"; partialCounts?: ClassificationCounts }
    | { code: "HANDLER_FAULT"; phase?: never; partialCounts?: ClassificationCounts }
    | { code: PlainSeanceErrorCode; phase?: never; partialCounts?: never }
  );

/** Builds an error for any code without `phase` / `partialCounts`. */
export function seanceError(code: PlainSeanceErrorCode, message: string, details?: unknown): SeanceError {
  return details === undefined ? { code, message } : { code, message, details };
}

/** Builds a TIMEOUT error. `partialCounts` is only accepted for phase "discovery". */
export function timeoutError(
  phase: "build",
  message: string,
  extra?: { details?: unknown },
): SeanceError;
export function timeoutError(
  phase: "discovery",
  message: string,
  extra?: { details?: unknown; partialCounts?: ClassificationCounts },
): SeanceError;
export function timeoutError(
  phase: TimeoutPhase,
  message: string,
  extra: { details?: unknown; partialCounts?: ClassificationCounts } = {},
): SeanceError {
  const base = { code: "TIMEOUT" as const, message, ...(extra.details !== undefined && { details: extra.details }) };
  return phase === "build"
    ? { ...base, phase }
    : { ...base, phase, ...(extra.partialCounts !== undefined && { partialCounts: extra.partialCounts }) };
}

/** Builds a HANDLER_FAULT error. */
export function handlerFaultError(
  message: string,
  extra: { details?: unknown; partialCounts?: ClassificationCounts } = {},
): SeanceError {
  return {
    code: "HANDLER_FAULT",
    message,
    ...(extra.details !== undefined && { details: extra.details }),
    ...(extra.partialCounts !== undefined && { partialCounts: extra.partialCounts }),
  };
}

export type Result<T, E = SeanceError> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}
export function err<E>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Entry input
// ---------------------------------------------------------------------------

export interface SeanceInput {
  contractName: string; // 1..128 chars
  legacySource: string; // non-empty, <= 1 MiB
  portSource: string; // non-empty, <= 1 MiB
  autopsyReport: string; // raw JSON text, <= 10 MB
  legacySolcVersion: string; // 0.x.y, < 0.8.0
  legacyOptimizer: boolean;
  legacyOptimizerRuns?: number; // 0..4294967295, required only when optimizer enabled
  onChainRuntimeCode: string; // 0x hex
  constructorArgs?: string; // ABI-encoded hex, default "0x"
  fuzzSeed?: string;
  timeoutSeconds?: number; // default 300, one deadline for build and all three phases
}

// ---------------------------------------------------------------------------
// ABI
// ---------------------------------------------------------------------------

export interface AbiParam {
  name: string;
  type: string;
  components?: AbiParam[];
}

/**
 * One entry of the legacy contract ABI (solc JSON ABI shape). The design names
 * `AbiFunction` but does not define it; this is the standard solc ABI entry,
 * restricted to the entry kinds the engine reads.
 */
export interface AbiFunction {
  type: "function" | "constructor" | "fallback" | "receive";
  /** Absent for constructor, fallback and receive. */
  name?: string;
  inputs: AbiParam[];
  outputs?: AbiParam[];
  /** Always set on loaded entries; `loadAbi` derives it from `payable`/`constant` when missing. */
  stateMutability: "pure" | "view" | "nonpayable" | "payable";
  /** Legacy (pre-0.4.16) raw fields; kept as found, `stateMutability` is authoritative. */
  constant?: boolean;
  payable?: boolean;
}

// ---------------------------------------------------------------------------
// Autopsy report (schema v1)
// ---------------------------------------------------------------------------

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

export type Operand =
  | { kind: "known"; value: string; type: string } // value is decimal
  | { kind: "param"; name: string; type: string }
  | { kind: "arrayLength"; name: string; type: string }
  | { kind: "unknown"; type: string };

export interface SitePrecondition {
  kind: "constructor-balance" | "approve" | "transfer";
  hint?: string;
}

export interface ArithmeticSite {
  id: string;
  function: string;
  operator: "+" | "-" | "*" | "**";
  operands: [Operand, Operand];
  location: SourceLocation;
  precondition?: SitePrecondition[];
}

export interface AutopsyReport {
  schemaVersion: "1";
  contract: string;
  sites: ArithmeticSite[];
}

// ---------------------------------------------------------------------------
// Input generator
// ---------------------------------------------------------------------------

export type ParamSlot =
  | { encoding: "static"; paramIndex: number; headOffset: number }
  | { encoding: "dynamicArrayLength"; paramIndex: number; headOffset: number };

/** One atomic choice: all assignments are applied together (1 single, 2 pair). */
export interface TargetEntry {
  /**
   * `value` is a bigint. JSON.stringify throws on bigint, so convert it to a
   * decimal string (`value.toString(10)`) before any JSON output, including
   * logs, reports and anything written to disk.
   */
  assignments: { slot: ParamSlot; value: bigint }[];
}

export interface SiteTargets {
  siteId: string;
  functionName: string;
  entries: TargetEntry[]; // 1..64
  unreachable: boolean;
}

/** One call of a seed sequence. The design does not define its fields beyond "call". */
export interface SeedCall {
  function: string;
  args: string[]; // decimal or 0x-hex, as produced by the generator
  actorIdx: number;
  value?: string; // decimal wei
}

export interface TargetPlan {
  sites: SiteTargets[]; // one entry per Arithmetic_Site
  seedSequences: SeedCall[][]; // each at most 10 calls
}

// ---------------------------------------------------------------------------
// Call records and classification
// ---------------------------------------------------------------------------

export interface NormLog {
  /** "SELF" sentinel for the deployment's own address, otherwise the emitter address. */
  emitter: "SELF" | string;
  topics: string[];
  data: string;
}

/** Observable_State as named fields to hex values (balance, view returns, mapping getters). */
export type ObservableState = Record<string, string>;

/** In-process Call_Record used by `classify`. */
export interface CallRecord {
  success: boolean;
  data: string;
  logs: NormLog[];
  state: ObservableState;
}

export interface CtorOutcome {
  success: boolean;
  data: string;
}

/** Call_Record as written on the wire by the handler. */
export interface CallRecordWire {
  success: boolean;
  data: string;
  logs: NormLog[];
  stateHash: string;
  /** Written only for records classified `port-bug`. */
  stateFields?: Record<string, string>;
}

/** One JSONL line, written by the handler. The handler never writes `ordinal`. */
export interface RecordLine {
  idx: number; // 0-based position in sequence; -1 for setup records
  function: string;
  selector: string;
  calldata: string;
  sender: string;
  value: string; // decimal wei
  legacy: CallRecordWire;
  port: CallRecordWire;
  classification: Classification;
  differingFields: string[];
  invalidRecord: boolean;
  afterDivergence: boolean; // true on every record after the first port-bug in the same sequence
}

/** Parsed by the engine. */
export interface OrderedRecord extends RecordLine {
  ordinal: number; // 1-based, from line order of the kept lines
  fuzzOrdinal?: number; // 1-based among idx >= 0; absent for setup records
}

// ---------------------------------------------------------------------------
// Séance report
// ---------------------------------------------------------------------------

export interface PrecedingCall {
  function: string;
  calldata: string;
  sender: string;
  value: string;
}

interface FindingBase {
  function: string;
  calldata: string; // hex, deployment calldata
  sender: string;
  value: string; // decimal wei
  precedingCalls: PrecedingCall[];
  site?: { id: string; location: SourceLocation } | "unattributed";
}

/** Shrunk: carries the pre-shrink handler-call count, no unshrunk markers. */
export interface ShrunkPart {
  originalLength: number;
  unshrunk?: never;
  unshrunkReason?: never;
}

/** Reported with its original sequence; always says why. */
export interface UnshrunkPart {
  unshrunk: true;
  unshrunkReason: UnshrunkReason;
  originalLength?: never;
}

export interface PortBugPart {
  classification: "port-bug";
  legacy: CallRecordWire;
  port: CallRecordWire;
  differingFields: string[];
}

export interface ExorcisedPart {
  classification: "exorcised";
  legacy?: never;
  port?: never;
  differingFields?: never;
}

/**
 * Shrunk xor unshrunk, orthogonally port-bug xor exorcised. Both axes narrow:
 * on `classification`, and on `unshrunk` (use the guards below).
 */
export type Finding = FindingBase & (ShrunkPart | UnshrunkPart) & (PortBugPart | ExorcisedPart);

export type UnshrunkFinding = Extract<Finding, { unshrunk: true }>;
export type PortBugFinding = Extract<Finding, { classification: "port-bug" }>;

export function isUnshrunkFinding(f: Finding): f is UnshrunkFinding {
  return f.unshrunk === true;
}
export function isPortBugFinding(f: Finding): f is PortBugFinding {
  return f.classification === "port-bug";
}

export interface SeanceReport {
  schemaVersion: "1";
  contract: string;
  seed: string; // best effort, does not make a campaign reproducible
  runs: number; // INVARIANT_RUNS
  depth: number; // INVARIANT_DEPTH
  totalCalls: number; // includes setup records
  counts: ClassificationCounts;
  taintedCalls: number; // already inside counts
  setupCalls: number; // already inside counts
  exorcisms: Finding[];
  portBugs: Finding[];
  sequenceResults: { total: number; endedExorcised: number; exorcisedAtIndex: number[] };
  shrinking: {
    witnessCap: 10;
    pairsFound: number; // = pairsSetup + pairsShrunk + pairsUnshrunk + pairsOverCap
    pairsSetup: number;
    pairsShrunk: number;
    pairsUnshrunk: number; // witness-not-failed, replay-mismatch, deadline
    pairsOverCap: number;
    deadlineReached: boolean;
  };
  unreachableSites: string[];
}
