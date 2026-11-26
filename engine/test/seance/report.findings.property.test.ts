// Feature: seance-engine, Property 22: One finding per function and class, cap, and unshrunk fallback
// **Validates: Requirements 7.12, 8.1, 8.3, 8.4, 8.5, 8.6, 8.7**
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  WITNESS_CAP,
  assignDispositions,
  buildReport,
  chooseReported,
  parseRecords,
  selectFindingPairs,
  validateReport,
  type DispositionKind,
  type PairProgress,
  type ParsedRecords,
  type ShrinkOutcome,
} from "../../src/seance/report.js";
import { computeTaint } from "../../src/seance/taint.js";
import { UNSHRUNK_REASONS, isPortBugFinding, isUnshrunkFinding } from "../../src/seance/types.js";
import type { AutopsyReport, Classification, RecordLine, TargetPlan } from "../../src/seance/types.js";

const NUM_RUNS = 300;
const FN_POOL = 16;
const SENDERS = ["0x" + "aa".repeat(20), "0x" + "bb".repeat(20), "0x" + "cc".repeat(20)];
const fnName = (i: number): string => `fn${i}`;

// --- generators --------------------------------------------------------------

interface RecSpec {
  cls: Classification;
  fn: number;
  sender: number;
}
type ProgState = "none" | "wnf" | "failedNoReplay" | "replayOk" | "replayWrongClass" | "replayNoRecord";
interface ProgSpec {
  state: ProgState;
  originalLength: number;
  wrongClass: Classification;
  precedingN: number;
}
interface Spec {
  nFns: number;
  setup: RecSpec[];
  seqs: RecSpec[][];
  deadline: boolean;
  allFinal: boolean;
  prog: ProgSpec[];
}

const classArb = fc.constantFrom<Classification>(
  "match", "match", "match", "reason-modernised",
  "exorcised", "exorcised", "exorcised", "exorcised", "port-bug", "port-bug", "port-bug",
);
const leadClassArb = fc.constantFrom<Classification>(
  "match", "reason-modernised", "exorcised", "exorcised", "exorcised", "port-bug", "port-bug", "port-bug",
);
const leadSpec = fc.record({ cls: leadClassArb, fn: fc.nat(FN_POOL - 1), sender: fc.nat(SENDERS.length - 1) });
// A setup port-bug taints every fuzz record, so it is rare here.
const setupClassArb = fc.constantFrom<Classification>(
  "match", "match", "match", "match", "match", "reason-modernised", "exorcised", "exorcised", "exorcised", "port-bug",
);
const setupSpec = fc.record({ cls: setupClassArb, fn: fc.nat(FN_POOL - 1), sender: fc.nat(SENDERS.length - 1) });
const recSpec = fc.record({ cls: classArb, fn: fc.nat(FN_POOL - 1), sender: fc.nat(SENDERS.length - 1) });
const progSpec: fc.Arbitrary<ProgSpec> = fc.record({
  state: fc.constantFrom<ProgState>("none", "wnf", "failedNoReplay", "replayOk", "replayOk", "replayWrongClass", "replayNoRecord"),
  originalLength: fc.integer({ min: 1, max: 64 }),
  wrongClass: fc.constantFrom<Classification>("match", "reason-modernised", "exorcised", "port-bug"),
  precedingN: fc.nat(3),
});
const specArb: fc.Arbitrary<Spec> = fc.record({
  nFns: fc.oneof(fc.integer({ min: 1, max: FN_POOL }), fc.constant(FN_POOL), fc.constant(FN_POOL)),
  setup: fc.array(setupSpec, { minLength: 0, maxLength: 6 }),
  // At most one untainted pair comes out of one sequence (a port-bug taints the rest, an exorcised
  // ends it), so reaching more than 10 fuzz pairs takes more than 10 sequences: 1..24 are generated.
  seqs: fc.array(
    fc.tuple(leadSpec, fc.array(recSpec, { minLength: 0, maxLength: 4 })).map(([lead, rest]) => [lead, ...rest]),
    { minLength: 1, maxLength: 24, size: "large" },
  ),
  deadline: fc.boolean(),
  allFinal: fc.boolean(),
  prog: fc.array(progSpec, { minLength: 40, maxLength: 40 }),
});

const wire = (data: string): RecordLine["legacy"] => ({ success: true, data, logs: [], stateHash: "0x00" });
const hex2 = (n: number): string => (n % 256).toString(16).padStart(2, "0");

function mkLine(idx: number, s: RecSpec, nFns: number, tainted: boolean, salt: number): RecordLine {
  return {
    idx,
    function: fnName(s.fn % nFns),
    selector: "0xa9059cbb",
    calldata: "0xa9059cbb" + salt.toString(16).padStart(8, "0"),
    sender: SENDERS[s.sender]!,
    value: String(salt % 3),
    legacy: wire("0x" + hex2(salt)),
    port: wire("0x" + hex2(salt + 1)),
    classification: s.cls,
    differingFields: s.cls === "port-bug" ? ["returnData"] : [],
    invalidRecord: false,
    afterDivergence: tainted,
  };
}

interface Kept {
  rec: RecordLine;
  ordinal: number;
  seq: number; // -1 for setup
  pos: number;
}
interface Built {
  spec: Spec;
  kept: Kept[];
  jsonl: string;
  runs: number;
}

function build(spec: Spec): Built {
  let salt = 1;
  const kept: Kept[] = [];
  const setupTaint = computeTaint(spec.setup.map((s) => ({ classification: s.cls })), false);
  spec.setup.forEach((s, i) => {
    kept.push({ rec: mkLine(-1, s, spec.nFns, setupTaint[i]!, salt++), ordinal: kept.length + 1, seq: -1, pos: i });
  });
  const setupDiverged = spec.setup.some((s) => s.cls === "port-bug");
  spec.seqs.forEach((raw, q) => {
    // As the handler does: the sequence ends at its first exorcised record.
    const cut = raw.findIndex((s) => s.cls === "exorcised");
    const specs = cut >= 0 ? raw.slice(0, cut + 1) : raw;
    const taint = computeTaint(specs.map((x) => ({ classification: x.cls })), setupDiverged);
    specs.forEach((s, i) => {
      kept.push({ rec: mkLine(i, s, spec.nFns, taint[i]!, salt++), ordinal: kept.length + 1, seq: q, pos: i });
    });
  });
  const jsonl = kept.map((k) => JSON.stringify(k.rec)).join("\n") + "\n";
  return { spec, kept, jsonl, runs: spec.seqs.length };
}
const built = specArb.map(build);

function parse(b: Built): ParsedRecords {
  const r = parseRecords(b.jsonl, b.runs);
  if (!r.ok) throw new Error(`parse failed: ${r.error.message}`);
  return r.value;
}

// --- oracle ------------------------------------------------------------------

interface OPair {
  key: string;
  fn: string;
  cls: "exorcised" | "port-bug";
  first: Kept;
  setup: boolean;
}

function oraclePairs(b: Built): OPair[] {
  const m = new Map<string, OPair>();
  for (const k of b.kept) {
    const c = k.rec.classification;
    if (k.rec.afterDivergence || (c !== "exorcised" && c !== "port-bug")) continue;
    const key = `${k.rec.function}#${c}`;
    if (!m.has(key)) m.set(key, { key, fn: k.rec.function, cls: c, first: k, setup: k.seq === -1 });
  }
  const grp = (p: OPair): number => (p.setup ? 0 : p.cls === "exorcised" ? 1 : 2);
  return [...m.values()].sort((a, c) => grp(a) - grp(c) || a.first.ordinal - c.first.ordinal);
}

const libKey = (p: { function: string; classification: string }): string => `${p.function}|${p.classification}`;
const oKey = (p: OPair): string => libKey({ function: p.fn, classification: p.cls });

interface OProg {
  progress: PairProgress;
  replayOf: Map<string, RecordLine>;
  precedingOf: Map<string, RecordLine[]>;
  lengthOf: Map<string, number>;
}

function oracleProgress(b: Built, pairs: OPair[]): OProg {
  const witnessDone = new Set<string>();
  const replayDone = new Set<string>();
  const outcomes = new Map<string, ShrinkOutcome>();
  const replayOf = new Map<string, RecordLine>();
  const precedingOf = new Map<string, RecordLine[]>();
  const lengthOf = new Map<string, number>();
  let salt = 1000;
  pairs.forEach((p, i) => {
    const ps = b.spec.prog[i % b.spec.prog.length]!;
    let state = ps.state;
    if (!b.spec.deadline && b.spec.allFinal && (state === "none" || state === "failedNoReplay")) state = "wnf";
    const key = oKey(p);
    if (state === "none") return;
    witnessDone.add(key);
    if (state === "wnf") {
      outcomes.set(key, { witness: "not-failed" });
      return;
    }
    if (state === "failedNoReplay") {
      outcomes.set(key, { witness: "failed", originalLength: ps.originalLength });
      return;
    }
    replayDone.add(key);
    const preceding = Array.from({ length: ps.precedingN }, (_, j) => mkLine(j, { cls: "match", fn: i, sender: 1 }, FN_POOL, false, salt++));
    precedingOf.set(key, preceding);
    lengthOf.set(key, ps.originalLength);
    if (state === "replayNoRecord") {
      outcomes.set(key, { witness: "failed", originalLength: ps.originalLength, replay: { preceding } });
      return;
    }
    const cls: Classification = state === "replayOk" ? p.cls : ps.wrongClass === p.cls ? "match" : ps.wrongClass;
    const record: RecordLine = {
      ...mkLine(ps.precedingN, { cls, fn: i, sender: 2 }, FN_POOL, false, salt++),
      function: p.fn,
      differingFields: cls === "port-bug" ? ["state.x"] : [],
    };
    replayOf.set(key, record);
    outcomes.set(key, { witness: "failed", originalLength: ps.originalLength, replay: { record, preceding } });
  });
  return { progress: { witnessDone, replayDone, deadlineReached: b.spec.deadline, outcomes }, replayOf, precedingOf, lengthOf };
}

/** Disposition per the design, written independently from the implementation. */
function oracleDispositions(pairs: OPair[], prog: OProg): DispositionKind[] {
  let fuzz = 0;
  return pairs.map((p): DispositionKind => {
    if (p.setup) return "setup";
    if (fuzz++ >= 10) return "over-cap";
    const key = oKey(p);
    const out = prog.progress.outcomes.get(key);
    if (prog.progress.witnessDone.has(key) && out !== undefined) {
      if (out.witness === "not-failed") return "witness-not-failed";
      if (prog.progress.replayDone.has(key) && out.replay !== undefined) {
        const r = prog.replayOf.get(key);
        return r !== undefined && r.classification === p.cls ? "shrunk-confirmed" : "replay-mismatch";
      }
    }
    return prog.progress.deadlineReached ? "deadline" : "shrink";
  });
}

const REASON: Partial<Record<DispositionKind, string>> = {
  setup: "setup",
  "over-cap": "witness-cap",
  "witness-not-failed": "witness-not-failed",
  "replay-mismatch": "replay-mismatch",
  deadline: "deadline",
};

const AUTOPSY: AutopsyReport = { schemaVersion: "1", contract: "C", sites: [] };
const PLAN: TargetPlan = { sites: [], seedSequences: [] };

const strip = (r: { ordinal?: number; fuzzOrdinal?: number } & RecordLine): RecordLine => {
  const { ordinal: _o, fuzzOrdinal: _f, ...rest } = r;
  return rest;
};

// --- properties --------------------------------------------------------------

describe("Property 22: One finding per function and class, cap, and unshrunk fallback", () => {
  it("(1) selection: one untainted representative per (function, class), sorted, tainted-only pairs absent", () => {
    fc.assert(
      fc.property(built, (b) => {
        const parsed = parse(b);
        const actual = selectFindingPairs(parsed);
        const expected = oraclePairs(b);
        expect(actual.map((p) => [libKey(p), p.first.ordinal])).toEqual(expected.map((p) => [oKey(p), p.first.ordinal]));
        const keys = actual.map(libKey);
        expect(new Set(keys).size).toBe(keys.length);
        actual.forEach((p, i) => {
          expect(strip(p.first)).toEqual(expected[i]!.first.rec);
          expect(p.first.afterDivergence).toBe(false);
          expect(p.setup).toBe(expected[i]!.setup);
        });
        // Never a tainted-only pair: every pair key has at least one untainted record, and none of its
        // tainted records is the representative.
        const untaintedKeys = new Set(
          b.kept.filter((k) => !k.rec.afterDivergence && (k.rec.classification === "exorcised" || k.rec.classification === "port-bug"))
            .map((k) => libKey({ function: k.rec.function, classification: k.rec.classification })),
        );
        expect(keys.every((k) => untaintedKeys.has(k))).toBe(true);
        // Order: setup, then exorcised, then port-bug, each by first ordinal.
        const rank = (p: (typeof actual)[number]): number => (p.setup ? 0 : p.classification === "exorcised" ? 1 : 2);
        for (let i = 1; i < actual.length; i++) {
          const a = actual[i - 1]!;
          const c = actual[i]!;
          expect(rank(a) < rank(c) || (rank(a) === rank(c) && a.first.ordinal < c.first.ordinal)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(2) cap: at most 10 fuzz pairs shrink, the first 10 in order; setup pairs are outside the cap", () => {
    fc.assert(
      fc.property(built, (b) => {
        const pairs = selectFindingPairs(parse(b));
        const { dispositions } = assignDispositions(pairs);
        expect(WITNESS_CAP).toBe(10);
        const fuzzIdx = pairs.map((p, i) => (p.setup ? -1 : i)).filter((i) => i >= 0);
        const shrink = dispositions.filter((d) => d.disposition === "shrink");
        const over = dispositions.filter((d) => d.disposition === "over-cap");
        expect(shrink.length).toBe(Math.min(10, fuzzIdx.length));
        expect(over.length).toBe(Math.max(0, fuzzIdx.length - 10));
        fuzzIdx.forEach((pi, n) => expect(dispositions[pi]!.disposition).toBe(n < 10 ? "shrink" : "over-cap"));
        pairs.forEach((p, i) => {
          if (p.setup) {
            expect(dispositions[i]!.disposition).toBe("setup");
            expect(dispositions[i]!.unshrunkReason).toBe("setup");
          }
          expect(dispositions[i]!.pair).toBe(p);
        });
        expect(dispositions.filter((d) => d.disposition === "setup").length).toBe(pairs.length - fuzzIdx.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(3) dispositions with random progress: one outcome each, closed reasons, counts identity", () => {
    fc.assert(
      fc.property(built, (b) => {
        const pairs = selectFindingPairs(parse(b));
        const op = oraclePairs(b);
        const prog = oracleProgress(b, op);
        const { dispositions, shrinking } = assignDispositions(pairs, prog.progress);
        const expected = oracleDispositions(op, prog);
        expect(dispositions.map((d) => d.disposition)).toEqual(expected);
        const reasons: readonly string[] = UNSHRUNK_REASONS;
        dispositions.forEach((d, i) => {
          const k = expected[i]!;
          if (k === "shrink") {
            expect(d.outcome).toBe("pending");
            expect(b.spec.deadline).toBe(false);
          } else if (k === "shrunk-confirmed") {
            expect(d.outcome).toBe("shrunk");
            expect(d.unshrunkReason).toBeUndefined();
          } else {
            expect(d.outcome).toBe("unshrunk");
            expect(d.unshrunkReason).toBe(REASON[k]);
            expect(reasons).toContain(d.unshrunkReason);
          }
          if (b.spec.deadline) expect(k).not.toBe("shrink");
        });
        const n = (k: DispositionKind): number => expected.filter((x) => x === k).length;
        expect(shrinking.witnessCap).toBe(10);
        expect(shrinking.deadlineReached).toBe(b.spec.deadline);
        expect(shrinking.pairsSetup).toBe(n("setup"));
        expect(shrinking.pairsShrunk).toBe(n("shrunk-confirmed"));
        expect(shrinking.pairsUnshrunk).toBe(n("witness-not-failed") + n("replay-mismatch") + n("deadline"));
        expect(shrinking.pairsOverCap).toBe(n("over-cap"));
        expect(shrinking.pairsFound).toBe(
          shrinking.pairsSetup + shrinking.pairsShrunk + shrinking.pairsUnshrunk + shrinking.pairsOverCap,
        );
        // Pending pairs are the only ones not counted.
        expect(shrinking.pairsFound + n("shrink")).toBe(pairs.length);
        // Without progress nothing but setup/over-cap is final, and nothing throws.
        const bare = assignDispositions(pairs);
        expect(bare.shrinking.deadlineReached).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(4) chooseReported and buildReport: shrunk or unshrunk findings with the right fields, valid report", () => {
    fc.assert(
      fc.property(built, (b) => {
        const parsed = parse(b);
        const pairs = selectFindingPairs(parsed);
        const op = oraclePairs(b);
        const prog = oracleProgress(b, op);
        const result = assignDispositions(pairs, prog.progress);
        const expected = oracleDispositions(op, prog);
        let pending = 0;

        result.dispositions.forEach((d, i) => {
          const p = op[i]!;
          const key = oKey(p);
          if (expected[i] === "shrink") {
            pending++;
            expect(() => chooseReported(d)).toThrow();
            return;
          }
          const f = chooseReported(d);
          expect(f.function).toBe(p.fn);
          expect(f.classification).toBe(p.cls); // the original class, also on replay-mismatch
          expect(isPortBugFinding(f)).toBe(p.cls === "port-bug");
          if (expected[i] === "shrunk-confirmed") {
            const r = prog.replayOf.get(key)!;
            expect(isUnshrunkFinding(f)).toBe(false);
            expect("unshrunk" in f).toBe(false);
            expect("unshrunkReason" in f).toBe(false);
            expect(f.originalLength).toBe(prog.lengthOf.get(key));
            expect(f.calldata).toBe(r.calldata);
            expect(f.sender).toBe(r.sender);
            expect(f.value).toBe(r.value);
            expect(f.precedingCalls).toEqual(
              prog.precedingOf.get(key)!.map((x) => ({ function: x.function, calldata: x.calldata, sender: x.sender, value: x.value })),
            );
            if (isPortBugFinding(f)) {
              expect(f.legacy).toEqual(r.legacy);
              expect(f.port).toEqual(r.port);
              expect(f.differingFields).toEqual(r.differingFields);
            }
          } else {
            expect(isUnshrunkFinding(f)).toBe(true);
            if (isUnshrunkFinding(f)) {
              expect(f.unshrunk).toBe(true);
              expect(f.unshrunkReason).toBe(REASON[expected[i]!]);
            }
            expect("originalLength" in f).toBe(false);
            const o = p.first.rec;
            expect(f.calldata).toBe(o.calldata);
            expect(f.sender).toBe(o.sender);
            expect(f.value).toBe(o.value);
            const before =
              p.first.seq === -1
                ? []
                : b.kept.filter((k) => k.seq === p.first.seq && k.pos < p.first.pos).map((k) => k.rec);
            expect(f.precedingCalls).toEqual(
              before.map((x) => ({ function: x.function, calldata: x.calldata, sender: x.sender, value: x.value })),
            );
            if (isPortBugFinding(f)) {
              expect(f.legacy).toEqual(o.legacy);
              expect(f.port).toEqual(o.port);
              expect(f.differingFields).toEqual(o.differingFields);
            }
          }
          if (!isPortBugFinding(f)) {
            expect("legacy" in f).toBe(false);
            expect("port" in f).toBe(false);
            expect("differingFields" in f).toBe(false);
          }
        });

        if (pending > 0) {
          expect(() =>
            buildReport({ contract: "C", seed: "0x1", parsed, dispositions: result, autopsy: AUTOPSY, abi: [], plan: PLAN, skippedFunctions: [] }),
          ).toThrow();
          return;
        }
        const report = buildReport({
          contract: "C",
          seed: "0x1",
          parsed,
          dispositions: result,
          autopsy: AUTOPSY,
          abi: [],
          plan: PLAN,
          skippedFunctions: [],
        });
        const v = validateReport(report);
        if (!v.ok) throw new Error(v.error.message);
        expect(report.exorcisms.length + report.portBugs.length).toBe(pairs.length);
        const seen = [...report.exorcisms, ...report.portBugs].map(libKey);
        expect(new Set(seen).size).toBe(seen.length);
        expect(report.exorcisms.every((f) => f.classification === "exorcised")).toBe(true);
        expect(report.portBugs.every((f) => f.classification === "port-bug")).toBe(true);
        expect(report.shrinking).toEqual(result.shrinking);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(5) determinism: same inputs give the same pairs, dispositions and findings", () => {
    fc.assert(
      fc.property(built, (b) => {
        const run = (): unknown => {
          const parsed = parse(b);
          const pairs = selectFindingPairs(parsed);
          const prog = oracleProgress(b, oraclePairs(b));
          const res = assignDispositions(pairs, prog.progress);
          const findings = res.dispositions.map((d) => (d.disposition === "shrink" ? "pending" : chooseReported(d)));
          return { pairs, res, findings };
        };
        expect(run()).toEqual(run());
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
