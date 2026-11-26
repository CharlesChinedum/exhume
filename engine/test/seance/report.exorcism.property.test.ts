// Feature: seance-engine, Property 11: Exorcism truncates a sequence
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseRecords, selectFindingPairs, type ParsedRecords } from "../../src/seance/report.js";
import { computeTaint } from "../../src/seance/taint.js";
import type { Classification, RecordLine } from "../../src/seance/types.js";

const NUM_RUNS = 300;
const CLASSES: Classification[] = ["match", "reason-modernised", "exorcised", "port-bug"];
const FUNCTIONS = ["transfer", "batchTransfer", "approve", "mint"];
const SENDERS = ["0x" + "aa".repeat(20), "0x" + "bb".repeat(20), "0x" + "cc".repeat(20)];

const wire = (data: string): RecordLine["legacy"] => ({ success: true, data, logs: [], stateHash: "0x00" });

interface RecSpec {
  cls: Classification;
  fn: number;
  sender: number;
}
interface Spec {
  setup: RecSpec[];
  seqs: RecSpec[][];
  /** (i) every exorcised record is the last of its sequence; (ii) records may follow it. */
  wellFormed: boolean;
  tail: boolean;
  extraRuns: number;
}

const recSpec = (classes: fc.Arbitrary<Classification>): fc.Arbitrary<RecSpec> =>
  fc.record({ cls: classes, fn: fc.nat(FUNCTIONS.length - 1), sender: fc.nat(SENDERS.length - 1) });
const anyClass = fc.constantFrom<Classification>(
  ...CLASSES.flatMap((c) => Array<Classification>(c === "match" ? 5 : c === "exorcised" ? 2 : 2).fill(c)),
);
const setupClass = fc.constantFrom<Classification>("match", "match", "match", "reason-modernised", "port-bug");

const specArb: fc.Arbitrary<Spec> = fc.record({
  setup: fc.array(recSpec(setupClass), { minLength: 0, maxLength: 8 }),
  seqs: fc.array(fc.array(recSpec(anyClass), { minLength: 1, maxLength: 12 }), { minLength: 1, maxLength: 8 }),
  wellFormed: fc.boolean(),
  tail: fc.boolean(),
  extraRuns: fc.nat(2),
});

interface Built {
  spec: Spec;
  setupLines: RecordLine[];
  /** Raw sequences as written to the file (after the well-formed adjustment). */
  rawSeqs: RecordLine[][];
  runs: number;
  jsonl: string;
}

function line(idx: number, s: RecSpec, tainted: boolean, salt: number): RecordLine {
  return {
    idx,
    function: FUNCTIONS[s.fn]!,
    selector: "0xa9059cbb",
    calldata: "0xa9059cbb" + salt.toString(16).padStart(8, "0"),
    sender: SENDERS[s.sender]!,
    value: String(salt % 3),
    legacy: wire("0x" + (salt % 7).toString(16)),
    port: wire("0x" + (salt % 5).toString(16)),
    classification: s.cls,
    differingFields: s.cls === "port-bug" ? ["returnData"] : [],
    invalidRecord: false,
    afterDivergence: tainted,
  };
}

const jl = (lines: readonly RecordLine[]): string => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

function build(spec: Spec): Built {
  let salt = 1;
  const setupLines = spec.setup.map((s) => line(-1, s, false, salt++));
  const setupDiverged = spec.setup.some((s) => s.cls === "port-bug");
  const rawSeqs = spec.seqs.map((seqSpec) => {
    let specs = seqSpec;
    if (spec.wellFormed) {
      const first = specs.findIndex((s) => s.cls === "exorcised");
      if (first >= 0) specs = specs.slice(0, first + 1);
    }
    const taint = computeTaint(specs.map((x) => ({ classification: x.cls })), setupDiverged);
    return specs.map((s, i) => line(i, s, taint[i]!, salt++));
  });
  const useTail = spec.tail;
  const runs = useTail ? rawSeqs.length : rawSeqs.length + spec.extraRuns;
  const lines = [...setupLines, ...rawSeqs.flat(), ...(useTail ? rawSeqs[rawSeqs.length - 1]! : [])];
  return { spec, setupLines, rawSeqs, runs, jsonl: jl(lines) };
}

const built = specArb.map(build);

/** Independent oracle: truncate each raw sequence after its first exorcised record. */
function oracleSeqs(b: Built): RecordLine[][] {
  return b.rawSeqs.map((raw) => {
    const out: RecordLine[] = [];
    for (const r of raw) {
      out.push(r);
      if (r.classification === "exorcised") break;
    }
    return out;
  });
}
const oracleKept = (b: Built): RecordLine[] => [...b.setupLines, ...oracleSeqs(b).flat()];

function strip(r: ParsedRecords["records"][number]): RecordLine {
  const { ordinal: _o, fuzzOrdinal: _f, ...rest } = r;
  return rest;
}
function parse(b: Built, runs = b.runs): ParsedRecords {
  const r = parseRecords(b.jsonl, runs);
  if (!r.ok) throw new Error(`parse failed: ${r.error.message}`);
  return r.value;
}
function tally(rs: readonly RecordLine[]): Record<Classification, number> {
  const c: Record<Classification, number> = { match: 0, "reason-modernised": 0, exorcised: 0, "port-bug": 0 };
  for (const r of rs) c[r.classification]++;
  return c;
}
const firstExorcised = (seq: readonly RecordLine[]): number => seq.findIndex((r) => r.classification === "exorcised");

describe("Property 11: Exorcism truncates a sequence", () => {
  it("(1) sequences end at their first exorcised record and report its idx", () => {
    fc.assert(
      fc.property(built, (b) => {
        const p = parse(b);
        const o = oracleSeqs(b);
        expect(p.sequences.length).toBe(b.rawSeqs.length);
        const at: number[] = [];
        p.sequences.forEach((seq, i) => {
          const k = firstExorcised(seq);
          if (k >= 0) {
            expect(k).toBe(seq.length - 1);
            expect(seq.filter((r) => r.classification === "exorcised").length).toBe(1);
          }
          const rawFirst = firstExorcised(b.rawSeqs[i]!);
          expect(p.exorcisedAtIndex[i]).toBe(rawFirst >= 0 ? b.rawSeqs[i]![rawFirst]!.idx : null);
          if (rawFirst >= 0) at.push(rawFirst);
          expect(seq.length).toBe(o[i]!.length);
        });
        expect(p.sequenceResults.endedExorcised).toBe(at.length);
        expect(p.sequenceResults.exorcisedAtIndex).toEqual(at);
        expect(p.sequenceResults.total).toBe(b.rawSeqs.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(2) records up to and including the exorcised call are preserved in order", () => {
    fc.assert(
      fc.property(built, (b) => {
        const p = parse(b);
        const o = oracleSeqs(b);
        p.sequences.forEach((seq, i) => expect(seq.map(strip)).toEqual(o[i]));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(3) nothing after the exorcised record reaches records, counts, taint totals or findings", () => {
    fc.assert(
      fc.property(built, (b) => {
        const p = parse(b);
        const kept = oracleKept(b);
        expect(p.records.map(strip)).toEqual(kept);
        expect(p.counts).toEqual(tally(kept));
        expect(p.totalCalls).toBe(kept.length);
        expect(p.taintedCalls).toBe(kept.filter((r) => r.afterDivergence).length);

        // Oracle for finding selection over the kept records.
        const firsts = new Map<string, number>();
        kept.forEach((r, i) => {
          if (r.afterDivergence) return;
          if (r.classification !== "exorcised" && r.classification !== "port-bug") return;
          const key = `${r.function}|${r.classification}`;
          if (!firsts.has(key)) firsts.set(key, i + 1);
        });
        const group = (key: string, ord: number): [number, number] => {
          const setup = ord <= b.setupLines.length;
          return [setup ? 0 : key.endsWith("|exorcised") ? 1 : 2, ord];
        };
        const expected = [...firsts.entries()]
          .sort(([ka, a], [kb, c]) => {
            const [ga, oa] = group(ka, a);
            const [gb, oc] = group(kb, c);
            return ga - gb || oa - oc;
          })
          .map(([k, ord]) => [k, ord]);
        const actual = selectFindingPairs(p).map((x) => [`${x.function}|${x.classification}`, x.first.ordinal]);
        expect(actual).toEqual(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(4) port-bug and reason-modernised records never truncate", () => {
    fc.assert(
      fc.property(built, (b) => {
        const p = parse(b);
        b.rawSeqs.forEach((raw, i) => {
          if (firstExorcised(raw) >= 0) return;
          expect(p.sequences[i]!.map(strip)).toEqual(raw);
          expect(p.exorcisedAtIndex[i]).toBeNull();
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(5) setup records are untouched and sequences after an exorcism are unaffected", () => {
    fc.assert(
      fc.property(built, (b) => {
        const p = parse(b);
        expect(p.setupRecords.map(strip)).toEqual(b.setupLines);
        expect(p.setupCalls).toBe(b.setupLines.length);
        expect(p.sequences.every((s) => s.every((r) => r.idx >= 0))).toBe(true);
        expect(p.records.slice(0, b.setupLines.length).map(strip)).toEqual(b.setupLines);
        p.sequences.forEach((s) => expect(s[0]!.idx).toBe(0));
        // A sequence's contents do not depend on earlier sequences' truncation.
        const o = oracleSeqs(b);
        p.sequences.forEach((s, i) => expect(s.map(strip)).toEqual(o[i]));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(6) re-parsing the kept records is stable; ordinals are consecutive", () => {
    fc.assert(
      fc.property(built, (b) => {
        const p = parse(b);
        expect(p.records.map((r) => r.ordinal)).toEqual(p.records.map((_, i) => i + 1));
        const fuzz = p.records.filter((r) => r.idx >= 0);
        expect(fuzz.map((r) => r.fuzzOrdinal)).toEqual(fuzz.map((_, i) => i + 1));
        expect(p.records.filter((r) => r.idx < 0).every((r) => r.fuzzOrdinal === undefined)).toBe(true);

        const keptSeqs = p.sequences.map((s) => s.map(strip));
        const again: Built = {
          ...b,
          jsonl: jl([...p.setupRecords.map(strip), ...keptSeqs.flat(), ...(p.tail.present ? keptSeqs[keptSeqs.length - 1]! : [])]),
          runs: p.sequences.length,
        };
        const q = parse(again, p.sequences.length);
        expect(q.counts).toEqual(p.counts);
        expect(q.totalCalls).toBe(p.totalCalls);
        expect(q.taintedCalls).toBe(p.taintedCalls);
        expect(q.sequences.map((s) => s.length)).toEqual(p.sequences.map((s) => s.length));
        expect(q.exorcisedAtIndex).toEqual(p.exorcisedAtIndex);
        expect(q.sequenceResults).toEqual(p.sequenceResults);
        expect(q.records.map(strip)).toEqual(p.records.map(strip));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(7) counts sum to totalCalls and to the oracle's kept-record count", () => {
    fc.assert(
      fc.property(built, (b) => {
        const p = parse(b);
        const sum = p.counts.match + p.counts["reason-modernised"] + p.counts.exorcised + p.counts["port-bug"];
        expect(sum).toBe(p.totalCalls);
        expect(sum).toBe(oracleKept(b).length);
        expect(p.tail.present).toBe(b.spec.tail);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
