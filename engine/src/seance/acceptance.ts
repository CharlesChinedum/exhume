/**
 * BEC acceptance (task 13.2, Requirement 9).
 *
 * `checkBecAcceptance` is pure: it applies every Requirement 9 threshold to a finished `SeanceReport`.
 * `runBecAcceptance` loads the graveyard entry, runs the séance, checks it, and writes
 * `<graveyardRoot>/bec/seance-report.json` only when every condition holds. It never retries (design:
 * forge 1.5.1 campaigns are not reproducible, so a flaky result is investigated, not rerun) and every check
 * is a threshold or an invariant, never an exact count.
 *
 * The 2,000-call budget reads `report.firstExorcismFuzzOrdinal`. One input is not in the `SeanceReport` and
 * comes from the parsed discovery records: the sender's Legacy_Deployment balance at the time of the call.
 * `runBecAcceptance` obtains the setup records from `<project>/seance-out/records.jsonl` through `parseRecords`.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadGraveyardInput } from "./graveyard.js";
import { selectorOf } from "./keccak.js";
import { parseRecords, validateReport, writeReportAtomic, type ParsedRecords } from "./report.js";
import { RECORDS_FILE, runSeance, type RunnerDeps, type SeanceRunResult } from "./runner.js";
import {
  err,
  isPortBugFinding,
  isUnshrunkFinding,
  ok,
  seanceError,
  type Finding,
  type RecordLine,
  type Result,
  type SeanceError,
  type SeanceReport,
} from "./types.js";

export const BEC_FUNCTION = "batchTransfer";
export const BEC_SIGNATURE = "batchTransfer(address[],uint256)";
/** Requirement 9.3: the first exorcism must come within this many fuzz calls (inclusive). */
export const BEC_FUZZ_BUDGET = 2000;
export const BEC_MIN_RECEIVERS = 2;
export const BEC_MAX_RECEIVERS = 20;
/** BEC's constructor mints 7e9 * 10**18 to the deployer (BecToken.sol). */
export const BEC_INITIAL_SUPPLY = 7_000_000_000n * 10n ** 18n;
const TWO_256 = 1n << 256n;
const DEFAULT_DEPLOYER = "0x" + "00".repeat(19) + "d0";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What the balance provider returns: a bare balance, or one with derivation details. */
export type LegacyBalance = bigint | { balance: bigint; approximate: boolean; note: string };

export interface BecAcceptanceOptions {
  /** Sender's balance in the Legacy_Deployment when the finding's call runs. Absent: the balance check FAILS. */
  legacyBalanceOf?: (sender: string, finding: Finding) => LegacyBalance | undefined;
}

export type CheckStatus = "pass" | "fail" | "not-evaluated";

export interface AcceptanceCheck {
  /** Stable condition name; the same name appears in `details.failed[].condition`. */
  name: string;
  status: CheckStatus;
  /** JSON-safe (bigints as decimal strings). */
  observed: unknown;
  expected: unknown;
}

export interface FailedCondition {
  condition: string;
  observed: unknown;
  expected: unknown;
}

export interface AcceptanceSummary {
  checks: AcceptanceCheck[];
  firstExorcismFuzzOrdinal: number | null;
  receivers: number | null;
  value: string | null;
  product: string | null;
  wrappedProduct: string | null;
  senderLegacyBalance: string | null;
  /** `true` when the balance came from a model that cannot be exact for the finding (see `deriveSenderLegacyBalance`). */
  balanceApproximate: boolean | null;
  balanceNote: string | null;
}

export const CONDITIONS = {
  missingExorcism: "missing-exorcism",
  portBugCount: "port-bug-count",
  callBudget: "call-budget-exceeded",
  unshrunk: "unshrunk",
  calldata: "calldata-undecodable",
  receivers: "receivers-length",
  product: "product-below-2^256",
  balance: "wrapped-product-above-balance",
  counts: "counts-sum",
  reportInvalid: "report-invalid",
} as const;

// ---------------------------------------------------------------------------
// ABI helpers
// ---------------------------------------------------------------------------

const hexBody = (s: string): string | undefined => (/^0x(?:[0-9a-fA-F]{2})*$/.test(s) ? s.slice(2).toLowerCase() : undefined);
const word = (body: string, i: number): bigint | undefined => {
  const w = body.slice(i * 64, i * 64 + 64);
  return w.length === 64 ? BigInt("0x" + w) : undefined;
};
const wordAddr = (body: string, i: number): string | undefined => {
  const w = body.slice(i * 64, i * 64 + 64);
  return w.length === 64 ? "0x" + w.slice(24) : undefined;
};

export interface DecodedBatchTransfer {
  receivers: string[];
  value: bigint;
}

/** Decodes `batchTransfer(address[],uint256)` calldata. `undefined` when the selector or layout is wrong. */
export function decodeBatchTransfer(calldata: string): DecodedBatchTransfer | undefined {
  const body = hexBody(calldata);
  if (body === undefined || !("0x" + body.slice(0, 8) === selectorOf(BEC_SIGNATURE))) return undefined;
  const args = body.slice(8);
  if (args.length % 64 !== 0) return undefined;
  const offset = word(args, 0);
  const value = word(args, 1);
  if (offset === undefined || value === undefined || offset < 64n || offset % 32n !== 0n) return undefined;
  const at = Number(offset / 32n);
  const len = word(args, at);
  if (len === undefined || len > BigInt(args.length / 64)) return undefined;
  const receivers: string[] = [];
  for (let i = 0; i < Number(len); i++) {
    const a = wordAddr(args, at + 1 + i);
    if (a === undefined) return undefined;
    receivers.push(a);
  }
  return { receivers, value };
}

function decodeTransfer(calldata: string): { to: string; value: bigint } | undefined {
  const body = hexBody(calldata);
  if (body === undefined || "0x" + body.slice(0, 8) !== selectorOf("transfer(address,uint256)")) return undefined;
  const to = wordAddr(body.slice(8), 0);
  const value = word(body.slice(8), 1);
  return to === undefined || value === undefined ? undefined : { to, value };
}

function decodeTransferFrom(calldata: string): { from: string; to: string; value: bigint } | undefined {
  const body = hexBody(calldata);
  if (body === undefined || "0x" + body.slice(0, 8) !== selectorOf("transferFrom(address,address,uint256)")) return undefined;
  const a = body.slice(8);
  const from = wordAddr(a, 0);
  const to = wordAddr(a, 1);
  const value = word(a, 2);
  return from === undefined || to === undefined || value === undefined ? undefined : { from, to, value };
}

// ---------------------------------------------------------------------------
// Records-derived inputs
// ---------------------------------------------------------------------------

export interface DerivedBalance {
  balance: bigint;
  /** `true` when a call whose effect the model cannot know exactly precedes the finding, or the ledger went inconsistent. */
  approximate: boolean;
  note: string;
}

/**
 * Sender's Legacy_Deployment balance when the finding's call runs, computed from the Setup records plus the
 * finding's `precedingCalls`. The `SeanceReport` does not hold the setup records, so they are an input.
 *
 * Model (a token ledger over the legacy BEC semantics):
 *  1. The deployer starts with `initialSupply` (default BEC's 7e9 * 10**18; that constant is ASSUMED, not read
 *     from the chain). The `constructor` setup record gives the deployer address (default `0x..d0`).
 *  2. Each other setup record is applied when `legacy.success` is true (exact: success is recorded). This covers
 *     the token-share `transfer` calls (`share = balanceOf(deployer) / ACTOR_COUNT` to each other actor) and
 *     seed calls (`transfer`, `batchTransfer`, `transferFrom`).
 *  3. Preceding calls carry no recorded success, so their success is INFERRED from the ledger: `transfer`
 *     succeeds when the sender holds at least `value` and `to` is nonzero; `batchTransfer` when the receiver
 *     count is 1..20, `value > 0` and the sender holds at least the wrapped product. `approve` and
 *     `transferOwnership` do not move tokens. Any other preceding function (`transferFrom`, `pause`,
 *     `unpause`, ...) may or may not have moved tokens or blocked transfers: it is skipped and the result is
 *     marked approximate.
 * The result is exact when `approximate` is false (all preceding calls are in the modelled set), and
 * in that case it relies only on the initial supply assumption.
 */
export function deriveSenderLegacyBalance(
  setupRecords: readonly RecordLine[],
  finding: Pick<Finding, "sender" | "precedingCalls">,
  opts: { initialSupply?: bigint } = {},
): DerivedBalance {
  const ledger = new Map<string, bigint>();
  const bal = (a: string): bigint => ledger.get(a.toLowerCase()) ?? 0n;
  const set = (a: string, v: bigint): void => void ledger.set(a.toLowerCase(), v);
  const notes: string[] = [];
  let approximate = false;
  const deployer = (setupRecords.find((r) => r.function === "constructor")?.sender ?? DEFAULT_DEPLOYER).toLowerCase();
  set(deployer, opts.initialSupply ?? BEC_INITIAL_SUPPLY);
  const move = (from: string, to: string, v: bigint): boolean => {
    if (bal(from) < v) return false;
    set(from, bal(from) - v);
    set(to, bal(to) + v);
    return true;
  };
  const apply = (fn: string, calldata: string, sender: string, known: boolean | undefined): void => {
    if (fn === "transfer") {
      const d = decodeTransfer(calldata);
      if (!d) return;
      const okCall = known ?? (BigInt(d.to) !== 0n);
      if (okCall && !move(sender, d.to, d.value) && known === true) approximate = true;
    } else if (fn === "batchTransfer") {
      const d = decodeBatchTransfer(calldata);
      if (!d) return;
      const cnt = BigInt(d.receivers.length);
      const amount = (cnt * d.value) % TWO_256;
      const okCall = known ?? (cnt >= 1n && cnt <= 20n && d.value > 0n && bal(sender) >= amount);
      if (!okCall) return;
      if (bal(sender) < amount) {
        approximate = true;
        return;
      }
      set(sender, bal(sender) - amount);
      for (const r of d.receivers) set(r, bal(r) + d.value);
    } else if (fn === "transferFrom") {
      const d = decodeTransferFrom(calldata);
      if (known === true && d && !move(d.from, d.to, d.value)) approximate = true;
      if (known === undefined) {
        approximate = true;
        notes.push("a preceding transferFrom was skipped (allowance and success unknown)");
      }
    } else if (known === undefined && fn !== "approve" && fn !== "transferOwnership") {
      approximate = true;
      notes.push(`a preceding ${fn} call was skipped (effect on balances unknown)`);
    }
  };
  for (const r of setupRecords) {
    if (r.function === "constructor") continue;
    apply(r.function, r.calldata, r.sender, r.legacy.success);
  }
  for (const p of finding.precedingCalls) apply(p.function, p.calldata, p.sender, undefined);
  const note =
    `balance of ${finding.sender.toLowerCase()} from ${setupRecords.length} setup record(s) and ` +
    `${finding.precedingCalls.length} preceding call(s); initial supply assumed ${(opts.initialSupply ?? BEC_INITIAL_SUPPLY).toString(10)}` +
    (notes.length > 0 ? `; ${[...new Set(notes)].join("; ")}` : "") +
    (approximate ? "; APPROXIMATE" : "");
  return { balance: bal(finding.sender), approximate, note };
}

// ---------------------------------------------------------------------------
// Pure check
// ---------------------------------------------------------------------------

const dec = (v: bigint | undefined | null): string | null => (v === undefined || v === null ? null : v.toString(10));

export function checkBecAcceptance(report: SeanceReport, opts: BecAcceptanceOptions = {}): Result<AcceptanceSummary> {
  const checks: AcceptanceCheck[] = [];
  const add = (name: string, status: CheckStatus, observed: unknown, expected: unknown): void => {
    checks.push({ name, status, observed, expected });
  };
  const finding = report.exorcisms.find((f) => f.function === BEC_FUNCTION && f.classification === "exorcised");

  // (1) exorcism in batchTransfer
  add(
    CONDITIONS.missingExorcism,
    finding ? "pass" : "fail",
    { exorcisedFunctions: report.exorcisms.map((f) => f.function), exorcisedCalls: report.counts.exorcised },
    `an exorcised finding in ${BEC_FUNCTION}`,
  );

  // (2) zero port bugs
  const portBugFindings = report.portBugs.filter(isPortBugFinding).length;
  const portBugCount = report.counts["port-bug"];
  add(
    CONDITIONS.portBugCount,
    portBugCount === 0 && report.portBugs.length === 0 ? "pass" : "fail",
    { counts: portBugCount, findings: report.portBugs.length, portBugFindings },
    { counts: 0, findings: 0 },
  );

  // (3) call budget (only meaningful when an exorcism exists; a missing one is already a failure above)
  const ordinal = report.firstExorcismFuzzOrdinal;
  if (!finding) {
    add(CONDITIONS.callBudget, "not-evaluated", ordinal, `at most ${BEC_FUZZ_BUDGET}`);
  } else {
    add(
      CONDITIONS.callBudget,
      ordinal !== null && ordinal <= BEC_FUZZ_BUDGET ? "pass" : "fail",
      ordinal,
      `fuzzOrdinal of the first ${BEC_FUNCTION} exorcism at most ${BEC_FUZZ_BUDGET}`,
    );
  }

  // (4) shrunk and replay-confirmed
  let receivers: number | null = null;
  let value: bigint | null = null;
  let product: bigint | null = null;
  let wrapped: bigint | null = null;
  let balance: bigint | null = null;
  let approx: boolean | null = null;
  let balanceNote: string | null = null;
  if (!finding) {
    add(CONDITIONS.unshrunk, "not-evaluated", null, "shrunk and replay-confirmed");
  } else if (isUnshrunkFinding(finding)) {
    add(CONDITIONS.unshrunk, "fail", { unshrunkReason: finding.unshrunkReason }, "shrunk and replay-confirmed");
  } else {
    add(CONDITIONS.unshrunk, "pass", { originalLength: finding.originalLength }, "shrunk and replay-confirmed");
  }

  // (5) shrunk calldata shape and balance (only on a shrunk finding)
  const shrunk = finding !== undefined && !isUnshrunkFinding(finding) ? finding : undefined;
  if (!shrunk) {
    for (const n of [CONDITIONS.calldata, CONDITIONS.receivers, CONDITIONS.product, CONDITIONS.balance]) add(n, "not-evaluated", null, null);
  } else {
    const d = decodeBatchTransfer(shrunk.calldata);
    if (!d) {
      add(CONDITIONS.calldata, "fail", shrunk.calldata.slice(0, 74), `${BEC_SIGNATURE} calldata`);
      for (const n of [CONDITIONS.receivers, CONDITIONS.product, CONDITIONS.balance]) add(n, "not-evaluated", null, null);
    } else {
      add(CONDITIONS.calldata, "pass", BEC_SIGNATURE, BEC_SIGNATURE);
      receivers = d.receivers.length;
      value = d.value;
      product = BigInt(receivers) * value;
      wrapped = product % TWO_256;
      add(
        CONDITIONS.receivers,
        receivers >= BEC_MIN_RECEIVERS && receivers <= BEC_MAX_RECEIVERS ? "pass" : "fail",
        receivers,
        `${BEC_MIN_RECEIVERS}..${BEC_MAX_RECEIVERS} inclusive`,
      );
      add(CONDITIONS.product, product >= TWO_256 ? "pass" : "fail", { receivers, value: dec(value), product: dec(product) }, "receivers * value >= 2^256");
      const provided = opts.legacyBalanceOf?.(shrunk.sender, shrunk);
      if (provided === undefined) {
        add(CONDITIONS.balance, "fail", { wrappedProduct: dec(wrapped), senderLegacyBalance: "unavailable" }, "wrapped product <= sender's legacy balance");
      } else {
        const p = typeof provided === "bigint" ? { balance: provided, approximate: false, note: "" } : provided;
        balance = p.balance;
        approx = p.approximate;
        balanceNote = p.note === "" ? null : p.note;
        add(
          CONDITIONS.balance,
          wrapped <= balance ? "pass" : "fail",
          { wrappedProduct: dec(wrapped), senderLegacyBalance: dec(balance), balanceApproximate: approx },
          "wrapped product <= sender's legacy balance",
        );
      }
    }
  }

  // (6) invariants
  const sum = Object.values(report.counts).reduce((a, b) => a + b, 0);
  add(CONDITIONS.counts, sum === report.totalCalls ? "pass" : "fail", { sum, totalCalls: report.totalCalls }, "counts sum to totalCalls");
  const valid = validateReport(report);
  add(
    CONDITIONS.reportInvalid,
    valid.ok ? "pass" : "fail",
    valid.ok ? null : valid.error.message,
    "report passes schema and semantic validation",
  );

  const failed: FailedCondition[] = checks
    .filter((c) => c.status === "fail")
    .map((c) => ({ condition: c.name, observed: c.observed, expected: c.expected }));
  if (failed.length > 0) {
    const text = failed
      .map((f) => {
        const o = f.observed as { unshrunkReason?: string } | null;
        return f.condition === CONDITIONS.unshrunk && o?.unshrunkReason !== undefined ? `${f.condition} (unshrunkReason: ${o.unshrunkReason})` : f.condition;
      })
      .join(", ");
    return err(seanceError("ACCEPTANCE_FAILED", `BEC acceptance failed: ${text}`, { failed, checks }));
  }
  return ok({
    checks,
    firstExorcismFuzzOrdinal: ordinal,
    receivers,
    value: dec(value),
    product: dec(product),
    wrappedProduct: dec(wrapped),
    senderLegacyBalance: dec(balance),
    balanceApproximate: approx,
    balanceNote,
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface BecAcceptanceDeps extends Omit<RunnerDeps, "graveyardRoot" | "graveyardName"> {
  /** Reads `<graveyardRoot>/<name>/` inputs and receives `<graveyardRoot>/<name>/seance-report.json` on success. */
  graveyardRoot: string;
  /** Test seam: replaces `runSeance`. It must keep `tempDir` (records file) in its result. */
  seance?: (input: unknown, deps: RunnerDeps) => Promise<Result<SeanceRunResult>>;
}

export interface BecAcceptanceRun {
  summary: AcceptanceSummary;
  report: SeanceReport;
  reportPath: string;
}

/**
 * Loads the graveyard entry, runs the séance (without letting `runSeance` write the report), checks
 * acceptance and writes the report only on a pass. A `runSeance` error is returned unchanged. A failed
 * acceptance returns `ACCEPTANCE_FAILED` and leaves any existing report untouched.
 */
export async function runBecAcceptance(
  deps: BecAcceptanceDeps,
  opts: { name?: string; fuzzSeed?: string; timeoutSeconds?: number; initialSupply?: bigint } = {},
): Promise<Result<BecAcceptanceRun, SeanceError>> {
  const name = opts.name ?? "bec";
  const input = loadGraveyardInput(deps.graveyardRoot, name, {
    ...(opts.fuzzSeed !== undefined && { fuzzSeed: opts.fuzzSeed }),
    ...(opts.timeoutSeconds !== undefined && { timeoutSeconds: opts.timeoutSeconds }),
  });
  if (!input.ok) return input;
  const { graveyardRoot, seance, ...rest } = deps;
  const run = await (seance ?? runSeance)(input.value, { ...rest, keepTempOnSuccess: true });
  if (!run.ok) return run;
  const { report, tempDir } = run.value;
  let parsed: Result<ParsedRecords>;
  try {
    parsed = parseRecords(readFileSync(join(tempDir!, RECORDS_FILE), "utf8"), report.runs);
  } catch (e) {
    parsed = err(seanceError("SEANCE_FAILED", `cannot read the discovery records for the acceptance check: ${(e as Error).message}`));
  } finally {
    if (tempDir !== undefined && deps.keepTempOnSuccess !== true) rmSync(tempDir, { recursive: true, force: true });
  }
  if (!parsed.ok) return parsed;
  if (parsed.value.totalCalls !== report.totalCalls) {
    return err(
      seanceError("SEANCE_FAILED", `discovery records (${parsed.value.totalCalls} calls) do not match the report (${report.totalCalls} calls)`),
    );
  }
  const checked = checkBecAcceptance(report, {
    legacyBalanceOf: (_sender, finding) =>
      deriveSenderLegacyBalance(parsed.value.setupRecords, finding, opts.initialSupply !== undefined ? { initialSupply: opts.initialSupply } : {}),
  });
  if (!checked.ok) return checked;
  const written = await writeReportAtomic(graveyardRoot, name, report);
  if (!written.ok) return written;
  return ok({ summary: checked.value, report, reportPath: written.value.path });
}

// ===========================================================================
// Planted_Port_Bug acceptance (task 15.1, Requirement 10.1 to 10.6)
// ===========================================================================

export const PLANTED_FUNCTION = "transferFrom";
/** Requirement 10.3: preceding calls, excluding the failing call. */
export const PLANTED_MAX_PRECEDING = 3;
/**
 * State keys of the allowance getter in `differingFields` (`state.allowance(i,j)`, Actor_Set indices). BEC's
 * `allowed` mapping is `internal`, so the Observable_State reads it through the public two-address getter
 * `allowance(address,address)` (Requirement 10.4 says "the `allowed` mapping value").
 */
export const ALLOWANCE_STATE_PREFIX = "state.allowance(";
/** Name used for the (optional) planted report: never `bec`. */
export const PLANTED_REPORT_NAME = "bec-planted";

export const PLANTED_CONDITIONS = {
  notDetected: "planted-bug-not-detected",
  countsMismatch: "port-bug-counts-mismatch",
  notInTransferFrom: "port-bug-not-in-transferFrom",
  noAllowanceField: "allowance-field-not-differing",
  unshrunk: "unshrunk",
  precedingCalls: "preceding-calls-exceed-3",
  counts: "counts-sum",
  reportInvalid: "report-invalid",
} as const;

export interface PlantedAcceptanceSummary {
  checks: AcceptanceCheck[];
  /** The finding that satisfies 10.2 to 10.5. */
  finding: Finding;
  precedingCalls: number;
  differingFields: string[];
}

const isAllowanceKey = (f: string): boolean => f.startsWith(ALLOWANCE_STATE_PREFIX);

/**
 * Pure. Requirement 10: at least one `port-bug` (10.1) attributed to `transferFrom` (10.2), whose differing
 * fields name an allowance state key after a call that returned the same result in both deployments (10.4,
 * 10.5), and which is shrunk and replay-confirmed with at most 3 preceding calls (10.3). Zero port bugs
 * fails with `planted-bug-not-detected` (10.6).
 */
export function checkPlantedBugAcceptance(report: SeanceReport): Result<PlantedAcceptanceSummary> {
  const checks: AcceptanceCheck[] = [];
  const add = (name: string, status: CheckStatus, observed: unknown, expected: unknown): void => {
    checks.push({ name, status, observed, expected });
  };
  const N = "not-evaluated" as const;
  const bugs = report.portBugs.filter(isPortBugFinding);
  const counted = report.counts["port-bug"];

  // 10.6 / 10.1
  const none = counted === 0 && report.portBugs.length === 0;
  add(PLANTED_CONDITIONS.notDetected, none ? "fail" : "pass", { counts: counted, findings: report.portBugs.length }, "at least one port-bug divergence");
  if (none) {
    for (const n of [
      PLANTED_CONDITIONS.countsMismatch,
      PLANTED_CONDITIONS.notInTransferFrom,
      PLANTED_CONDITIONS.noAllowanceField,
      PLANTED_CONDITIONS.unshrunk,
      PLANTED_CONDITIONS.precedingCalls,
    ]) {
      add(n, N, null, null);
    }
  } else {
    add(
      PLANTED_CONDITIONS.countsMismatch,
      counted >= 1 && report.portBugs.length >= 1 ? "pass" : "fail",
      { counts: counted, findings: report.portBugs.length },
      "counts['port-bug'] >= 1 and at least one port-bug finding",
    );
    // 10.2
    const inTf = bugs.filter((f) => f.function === PLANTED_FUNCTION);
    add(
      PLANTED_CONDITIONS.notInTransferFrom,
      inTf.length > 0 ? "pass" : "fail",
      { portBugFunctions: [...new Set(bugs.map((f) => f.function))].sort() },
      `a port-bug finding in ${PLANTED_FUNCTION}`,
    );
    // 10.4 / 10.5: allowance differs, the call itself returned the same result in both
    const sameResult = (f: (typeof bugs)[number]): boolean => f.legacy.success === f.port.success && f.legacy.data === f.port.data;
    const withAllowance = inTf.filter((f) => f.differingFields.some(isAllowanceKey) && sameResult(f));
    if (inTf.length === 0) {
      add(PLANTED_CONDITIONS.noAllowanceField, N, null, null);
      add(PLANTED_CONDITIONS.unshrunk, N, null, null);
      add(PLANTED_CONDITIONS.precedingCalls, N, null, null);
    } else {
      add(
        PLANTED_CONDITIONS.noAllowanceField,
        withAllowance.length > 0 ? "pass" : "fail",
        inTf.map((f) => ({ differingFields: f.differingFields, sameResult: sameResult(f) })),
        `a ${PLANTED_FUNCTION} finding with a ${ALLOWANCE_STATE_PREFIX}i,j) field and the same success and return data in both deployments`,
      );
      if (withAllowance.length === 0) {
        add(PLANTED_CONDITIONS.unshrunk, N, null, null);
        add(PLANTED_CONDITIONS.precedingCalls, N, null, null);
      } else {
        // 10.3
        const shrunkOnes = withAllowance.filter((f) => !isUnshrunkFinding(f));
        add(
          PLANTED_CONDITIONS.unshrunk,
          shrunkOnes.length > 0 ? "pass" : "fail",
          shrunkOnes.length > 0
            ? { shrunk: shrunkOnes.length }
            : { unshrunkReason: withAllowance.map((f) => (isUnshrunkFinding(f) ? f.unshrunkReason : undefined)).filter((x) => x !== undefined)[0], unshrunkReasons: withAllowance.map((f) => (isUnshrunkFinding(f) ? f.unshrunkReason : null)) },
          "a shrunk and replay-confirmed finding",
        );
        if (shrunkOnes.length === 0) {
          add(PLANTED_CONDITIONS.precedingCalls, N, null, null);
        } else {
          const lens = shrunkOnes.map((f) => f.precedingCalls.length);
          add(
            PLANTED_CONDITIONS.precedingCalls,
            lens.some((n) => n <= PLANTED_MAX_PRECEDING) ? "pass" : "fail",
            { precedingCalls: lens },
            `a shrunk finding with at most ${PLANTED_MAX_PRECEDING} preceding calls`,
          );
        }
      }
    }
  }

  const sum = Object.values(report.counts).reduce((a, b) => a + b, 0);
  add(PLANTED_CONDITIONS.counts, sum === report.totalCalls ? "pass" : "fail", { sum, totalCalls: report.totalCalls }, "counts sum to totalCalls");
  const valid = validateReport(report);
  add(PLANTED_CONDITIONS.reportInvalid, valid.ok ? "pass" : "fail", valid.ok ? null : valid.error.message, "report passes schema and semantic validation");

  const failed: FailedCondition[] = checks
    .filter((c) => c.status === "fail")
    .map((c) => ({ condition: c.name, observed: c.observed, expected: c.expected }));
  if (failed.length > 0) {
    const text = failed
      .map((f) => {
        const o = f.observed as { unshrunkReason?: string } | null;
        return f.condition === PLANTED_CONDITIONS.unshrunk && o?.unshrunkReason !== undefined ? `${f.condition} (unshrunkReason: ${o.unshrunkReason})` : f.condition;
      })
      .join(", ");
    return err(seanceError("ACCEPTANCE_FAILED", `Planted bug acceptance failed: ${text}`, { failed, checks, counts: report.counts }));
  }
  const best = bugs
    .filter((f) => f.function === PLANTED_FUNCTION && !isUnshrunkFinding(f) && f.differingFields.some(isAllowanceKey) && f.precedingCalls.length <= PLANTED_MAX_PRECEDING)
    .sort((a, b) => a.precedingCalls.length - b.precedingCalls.length)[0]!;
  return ok({ checks, finding: best, precedingCalls: best.precedingCalls.length, differingFields: best.differingFields });
}

export interface PlantedBugDeps extends BecAcceptanceDeps {
  /**
   * Where the planted report goes, as `<outputRoot>/bec-planted/seance-report.json`, only on a pass.
   * Absent: nothing is written. The input is always read from `graveyardRoot/bec`, which is never written.
   */
  outputRoot?: string;
}

export interface PlantedBugRun {
  summary: PlantedAcceptanceSummary;
  report: SeanceReport;
  reportPath?: string;
  /** Present when `keepTempOnSuccess` kept the temp project (records at `seance-out/records.jsonl`). */
  tempDir?: string;
}

/**
 * Loads `<graveyardRoot>/<name>` (default `bec`), replaces its port source with `plant(portSource)`, runs the
 * séance and checks Requirement 10. The report is never written to the source entry.
 */
export async function runPlantedBugAcceptance(
  deps: PlantedBugDeps,
  opts: { plant: (portSource: string) => string; name?: string; fuzzSeed?: string; timeoutSeconds?: number },
): Promise<Result<PlantedBugRun, SeanceError>> {
  const input = loadGraveyardInput(deps.graveyardRoot, opts.name ?? "bec", {
    ...(opts.fuzzSeed !== undefined && { fuzzSeed: opts.fuzzSeed }),
    ...(opts.timeoutSeconds !== undefined && { timeoutSeconds: opts.timeoutSeconds }),
  });
  if (!input.ok) return input;
  let planted: string;
  try {
    planted = opts.plant(input.value.portSource);
  } catch (e) {
    return err(seanceError("INVALID_INPUT", `cannot plant the bug: ${(e as Error).message}`));
  }
  const { graveyardRoot: _root, outputRoot, seance, ...rest } = deps;
  const run = await (seance ?? runSeance)({ ...input.value, portSource: planted }, rest);
  if (!run.ok) return run;
  const { report, tempDir } = run.value;
  const checked = checkPlantedBugAcceptance(report);
  if (!checked.ok) return checked;
  const kept = tempDir !== undefined ? { tempDir } : {};
  if (outputRoot === undefined) return ok({ summary: checked.value, report, ...kept });
  const written = await writeReportAtomic(outputRoot, PLANTED_REPORT_NAME, report);
  if (!written.ok) return written;
  return ok({ summary: checked.value, report, reportPath: written.value.path, ...kept });
}
