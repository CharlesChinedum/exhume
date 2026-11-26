// Feature: seance-engine, Property 12: Divergence taint flags later records and excludes them from findings
// **Validates: Requirements 5.5, 8.4**
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseRecords, selectFindingPairs } from "../../src/seance/report.js";
import { computeTaint, verifyTaint } from "../../src/seance/taint.js";
import type { Classification, OrderedRecord, RecordLine } from "../../src/seance/types.js";

const NUM_RUNS = 300;
const FNS = ["alpha", "beta", "gamma", "delta"];

interface Spec {
  cls: Classification;
  fn: number;
}
interface StreamSpec {
  setup: Spec[];
  seqs: Spec[][];
}

// --- generators ----------------------------------------------------------------

const specOf = (classes: Classification[]): fc.Arbitrary<Spec> =>
  fc.record({ cls: fc.constantFrom(...classes), fn: fc.nat(FNS.length - 1) });

const setupClasses: Classification[] = [
  "match", "match", "reason-modernised", "exorcised", "exorcised", "port-bug", "port-bug",
];
const fuzzClasses: Classification[] = [
  "match", "match", "match", "reason-modernised", "reason-modernised", "exorcised", "port-bug", "port-bug",
];

/** The handler ends a sequence at its first exorcised record (Requirement 5.3). */
function truncate(seq: Spec[]): Spec[] {
  const i = seq.findIndex((s) => s.cls === "exorcised");
  return i < 0 ? seq : seq.slice(0, i + 1);
}

const streamArb: fc.Arbitrary<StreamSpec> = fc.record({
  setup: fc.array(specOf(setupClasses), { minLength: 0, maxLength: 6 }),
  seqs: fc
    .array(fc.array(specOf(fuzzClasses), { minLength: 1, maxLength: 10 }), { minLength: 1, maxLength: 12 })
    .map((s) => s.map(truncate)),
});

// --- independent oracle ----------------------------------------------------------

/** flag(i) = base || some earlier record in the same group is a port-bug. */
function oracleFlags(classes: Classification[], base: boolean): boolean[] {
  return classes.map((_, i) => base || classes.slice(0, i).some((c) => c === "port-bug"));
}

interface Rec {
  idx: number;
  spec: Spec;
  tainted: boolean;
  seq: number; // -1 for setup
}

/** Stream in file order (setup first) with the oracle's expected flags. */
function oracleStream(s: StreamSpec): { recs: Rec[]; setupDiverged: boolean } {
  const setupDiverged = s.setup.some((x) => x.cls === "port-bug");
  const recs: Rec[] = [];
  const sf = oracleFlags(s.setup.map((x) => x.cls), false);
  s.setup.forEach((spec, i) => recs.push({ idx: -1, spec, tainted: sf[i]!, seq: -1 }));
  s.seqs.forEach((seq, q) => {
    const f = oracleFlags(seq.map((x) => x.cls), setupDiverged);
    seq.forEach((spec, i) => recs.push({ idx: i, spec, tainted: f[i]!, seq: q }));
  });
  return { recs, setupDiverged };
}

const wire = (data: string): RecordLine["legacy"] => ({ success: true, data, logs: [], stateHash: "0x00" });

function toLine(r: Rec, flag: boolean, n: number): RecordLine {
  const cls = r.spec.cls;
  return {
    idx: r.idx,
    function: FNS[r.spec.fn]!,
    selector: "0xa9059cbb",
    calldata: "0xa9059cbb" + n.toString(16).padStart(8, "0"),
    sender: "0x" + "aa".repeat(20),
    value: "0",
    legacy: wire("0x01"),
    port: wire(cls === "port-bug" ? "0x02" : "0x01"),
    classification: cls,
    differingFields: cls === "port-bug" ? ["returnData"] : [],
    invalidRecord: false,
    afterDivergence: flag,
  };
}

const ordered = (recs: Rec[], flags: boolean[]): OrderedRecord[] =>
  recs.map((r, i) => ({ ...toLine(r, flags[i]!, i + 1), ordinal: i + 1 }));

const pairSet = (items: { function: string; classification: string }[]): string[] =>
  [...new Set(items.map((p) => `${p.function}|${p.classification}`))].sort();

function parse(recs: Rec[], nSeq: number) {
  const jsonl = recs.map((r, i) => JSON.stringify(toLine(r, r.tainted, i + 1))).join("\n") + "\n";
  const parsed = parseRecords(jsonl, nSeq);
  if (!parsed.ok) throw new Error(`parseRecords failed: ${parsed.error.message}`);
  return parsed.value;
}

// --- properties --------------------------------------------------------------------

describe("Property 12: divergence taint", () => {
  it("(1) computeTaint equals the oracle", () => {
    const seqArb = fc.array(specOf(["match", "reason-modernised", "exorcised", "port-bug", "port-bug"]), {
      minLength: 0,
      maxLength: 10,
    });
    fc.assert(
      fc.property(seqArb, fc.boolean(), (seq, setupDiverged) => {
        const classes = seq.map((s) => s.cls);
        const flags = computeTaint(
          classes.map((classification) => ({ classification })),
          setupDiverged,
        );
        expect(flags).toEqual(oracleFlags(classes, setupDiverged));
        expect(flags.length).toBe(classes.length);
        // monotone non-decreasing
        for (let i = 1; i < flags.length; i++) expect(flags[i]! || !flags[i - 1]!).toBe(true);
        if (setupDiverged) expect(flags.every(Boolean)).toBe(true);
        else {
          expect(flags[0] ?? false).toBe(false); // a new sequence starts unflagged
          const first = classes.indexOf("port-bug");
          if (first >= 0) expect(flags[first]).toBe(false); // first port-bug not flagged
          // flags only turn on strictly after the first port-bug
          flags.forEach((f, i) => expect(f).toBe(first >= 0 && i > first));
        }
        // other classes alone never taint
        if (!classes.includes("port-bug") && !setupDiverged) expect(flags.some(Boolean)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(2) verifyTaint accepts consistent streams and names the first flipped record", () => {
    fc.assert(
      fc.property(
        streamArb,
        fc.nat(1000),
        fc.nat(1000),
        fc.boolean(),
        (spec, a, b, two) => {
          const { recs } = oracleStream(spec);
          const good = recs.map((r) => r.tainted);
          expect(verifyTaint(ordered(recs, good)).ok).toBe(true);
          if (recs.length === 0) return;

          const p1 = a % recs.length;
          const flipped = [p1];
          if (two && recs.length > 1) {
            let p2 = b % recs.length;
            if (p2 === p1) p2 = (p2 + 1) % recs.length;
            flipped.push(p2);
          }
          const bad = good.map((f, i) => (flipped.includes(i) ? !f : f));
          const res = verifyTaint(ordered(recs, bad));
          expect(res.ok).toBe(false);
          if (res.ok) return;
          const first = Math.min(...flipped);
          expect(res.error.code).toBe("SEANCE_FAILED");
          expect(res.error.message).toContain(`record ${first + 1} (idx ${recs[first]!.idx})`);
          expect(res.error.details).toMatchObject({ ordinal: first + 1, idx: recs[first]!.idx });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("(2b) a setup port-bug flags later setup records and every fuzz record", () => {
    fc.assert(
      fc.property(streamArb, (spec) => {
        const { recs, setupDiverged } = oracleStream(spec);
        const setupClasses = spec.setup.map((s) => s.cls);
        const firstSetupBug = setupClasses.indexOf("port-bug");
        recs.forEach((r) => {
          if (r.idx === -1) {
            expect(r.tainted).toBe(firstSetupBug >= 0 && recs.indexOf(r) > firstSetupBug);
          } else if (setupDiverged) expect(r.tainted).toBe(true);
        });
        // the engine agrees: unflagging any record that should be flagged is rejected
        const flaggedPos = recs.findIndex((r) => r.tainted);
        if (flaggedPos >= 0) {
          const flags = recs.map((r, i) => (i === flaggedPos ? false : r.tainted));
          expect(verifyTaint(ordered(recs, flags)).ok).toBe(false);
        }
        if (setupDiverged) {
          expect(recs.filter((r) => r.idx >= 0).every((r) => r.tainted)).toBe(true);
          const noFuzzFlag = recs.map((r) => (r.idx >= 0 ? false : r.tainted));
          if (recs.some((r) => r.idx >= 0)) expect(verifyTaint(ordered(recs, noFuzzFlag)).ok).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(3) selectFindingPairs never selects a tainted record; counts keep tainted records", () => {
    fc.assert(
      fc.property(streamArb, (spec) => {
        const { recs } = oracleStream(spec);
        const parsed = parse(recs, spec.seqs.length);
        const pairs = selectFindingPairs(parsed);

        for (const p of pairs) {
          expect(p.first.afterDivergence).toBe(false);
          const o = recs[p.first.ordinal - 1]!;
          expect(o.tainted).toBe(false);
        }
        const expected = pairSet(
          recs
            .filter((r) => !r.tainted && (r.spec.cls === "exorcised" || r.spec.cls === "port-bug"))
            .map((r) => ({ function: FNS[r.spec.fn]!, classification: r.spec.cls })),
        );
        const got = pairs.map((p) => `${p.function}|${p.classification}`).sort();
        expect(got).toEqual(expected);

        const counts = { match: 0, "reason-modernised": 0, exorcised: 0, "port-bug": 0 };
        for (const r of recs) counts[r.spec.cls]++;
        expect(parsed.counts).toEqual(counts);
        expect(parsed.totalCalls).toBe(recs.length);
        expect(parsed.taintedCalls).toBe(recs.filter((r) => r.tainted).length);
        const sum = Object.values(parsed.counts).reduce((x, y) => x + y, 0);
        expect(sum).toBe(parsed.totalCalls);
        expect(parsed.records.every((r, i) => r.afterDivergence === recs[i]!.tainted)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(4) a setup port-bug taints every fuzz record and selects no fuzz pair", () => {
    const withSetupBug = fc
      .tuple(streamArb, fc.nat(100), fc.nat(FNS.length - 1))
      .map(([s, at, fn]): StreamSpec => {
        if (s.setup.some((x) => x.cls === "port-bug")) return s;
        const setup = [...s.setup];
        setup.splice(at % (setup.length + 1), 0, { cls: "port-bug", fn });
        return { ...s, setup };
      });
    fc.assert(
      fc.property(withSetupBug, (spec) => {
        const { recs, setupDiverged } = oracleStream(spec);
        expect(setupDiverged).toBe(true);
        const parsed = parse(recs, spec.seqs.length);
        const fuzz = recs.filter((r) => r.idx >= 0);
        expect(fuzz.length).toBeGreaterThan(0);
        expect(parsed.records.filter((r) => r.idx >= 0).every((r) => r.afterDivergence)).toBe(true);
        expect(selectFindingPairs(parsed).filter((p) => !p.setup)).toEqual([]);
        const laterSetup = recs.filter((r) => r.idx === -1 && r.tainted).length;
        expect(parsed.taintedCalls).toBe(fuzz.length + laterSetup);
        expect(parsed.totalCalls).toBe(recs.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
