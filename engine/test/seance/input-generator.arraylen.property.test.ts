/**
 * Task 7.3, Property 16: Array length times value pairs overflow and wrap.
 *
 * **Validates: Requirements 6.8, 6.14**
 *
 * Oracles (ceil division, head words, expected slots) are recomputed here and do
 * not reuse generator code.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { generateTargets } from "../../src/seance/input-generator.js";
import type { AbiFunction, AbiParam, ArithmeticSite, AutopsyReport, Operand } from "../../src/seance/types.js";

const NUM_RUNS = 300;

type Filler = "uint256" | "address" | "bool" | "bytes" | "uint256[3]" | "tuple3" | "tuple2addr";
type ArrayType = "address[]" | "uint256[]" | "uint8[]" | "bytes32[]";
type OtherKind = "valueParam" | "known";

const FILLERS: Filler[] = ["uint256", "address", "bool", "bytes", "uint256[3]", "tuple3", "tuple2addr"];

function fillerParam(kind: Filler, name: string): AbiParam {
  switch (kind) {
    case "tuple3":
      return {
        name,
        type: "tuple",
        components: [
          { name: "a", type: "uint256" },
          { name: "b", type: "uint8" },
          { name: "c", type: "bytes32" },
        ],
      };
    case "tuple2addr":
      return {
        name,
        type: "tuple",
        components: [
          { name: "a", type: "address" },
          { name: "b", type: "bool" },
        ],
      };
    default:
      return { name, type: kind };
  }
}

/** Independent oracle: head words per parameter. */
function oracleWords(p: AbiParam): number {
  if (p.type === "bytes" || p.type.endsWith("[]")) return 1;
  if (p.type === "uint256[3]") return 3;
  if (p.type === "tuple") return (p.components ?? []).length;
  return 1;
}

function oracleHeadOffset(inputs: AbiParam[], index: number): number {
  let words = 0;
  for (const p of inputs.slice(0, index)) words += oracleWords(p);
  return 4 + 32 * words;
}

interface Case {
  n: number; // value width N
  arrayType: ArrayType;
  fillers: Filler[];
  arrayPos: number;
  valuePos: number;
}

const caseArb: fc.Arbitrary<Case> = fc
  .record({
    n: fc.integer({ min: 1, max: 32 }).map((i) => i * 8),
    arrayType: fc.constantFrom<ArrayType>("address[]", "uint256[]", "uint8[]", "bytes32[]"),
    fillers: fc.array(fc.constantFrom(...FILLERS), { minLength: 0, maxLength: 3 }),
    a: fc.nat(),
    v: fc.nat(),
  })
  .map(({ n, arrayType, fillers, a, v }) => {
    const total = fillers.length + 2;
    const arrayPos = a % total;
    const free: number[] = [];
    for (let i = 0; i < total; i++) if (i !== arrayPos) free.push(i);
    const valuePos = free[v % free.length] as number;
    return { n, arrayType, fillers, arrayPos, valuePos };
  });

interface Built {
  abi: AbiFunction[];
  inputs: AbiParam[];
  report: AutopsyReport;
}

function build(c: Case, other: OtherKind = "valueParam", known?: bigint, knownType = "uint256"): Built {
  const inputs: AbiParam[] = [];
  let f = 0;
  const total = c.fillers.length + 2;
  for (let i = 0; i < total; i++) {
    if (i === c.arrayPos) inputs.push({ name: "_arr", type: c.arrayType });
    else if (i === c.valuePos && other === "valueParam") inputs.push({ name: "_value", type: `uint${c.n}` });
    else inputs.push(fillerParam(c.fillers[f++] as Filler, `f${i}`));
  }
  // With a known factor the value parameter slot is simply another filler (consumed above as a filler).
  if (other === "known") {
    // i === valuePos consumed a filler index; rebuild without skipping so counts line up.
    inputs.length = 0;
    f = 0;
    const fl = [...c.fillers, "uint256" as Filler];
    for (let i = 0; i < total; i++) {
      if (i === c.arrayPos) inputs.push({ name: "_arr", type: c.arrayType });
      else inputs.push(fillerParam(fl[f++] as Filler, `f${i}`));
    }
  }
  const abi: AbiFunction[] = [{ type: "function", name: "foo", inputs, stateMutability: "nonpayable" }];
  const cnt: Operand = { kind: "arrayLength", name: "_arr", type: "uint256" };
  const rhs: Operand =
    other === "valueParam"
      ? { kind: "param", name: "_value", type: `uint${c.n}` }
      : { kind: "known", value: (known as bigint).toString(10), type: knownType };
  const site: ArithmeticSite = {
    id: "s1",
    function: "foo",
    operator: "*",
    operands: [cnt, rhs],
    location: { file: "T.sol", line: 1, column: 1 },
  };
  return { abi, inputs, report: { schemaVersion: "1", contract: "T", sites: [site] } };
}

function run(b: Built) {
  const r = generateTargets(b.report, b.abi);
  if (!r.ok) throw new Error(`generateTargets failed: ${r.error.message}`);
  const s = r.value.sites[0];
  if (!s) throw new Error("no site");
  return { plan: r.value, site: s, again: generateTargets(b.report, b.abi) };
}

/** Independent ceil(M/n) via floor and remainder. */
const ceilOracle = (M: bigint, n: bigint): bigint => M / n + (M % n === 0n ? 0n : 1n);

describe("Property 16: Array length times value pairs overflow and wrap", () => {
  it("(1,2) 23 paired entries, each with exactly the length slot and value slot; n*v >= M and wraps below n", () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        const b = build(c);
        const { site } = run(b);
        const M = 1n << BigInt(c.n);
        expect(site.entries.length).toBeGreaterThanOrEqual(1);
        expect(site.entries.length).toBeLessThanOrEqual(64);
        expect(site.entries).toHaveLength(23);
        const lens: bigint[] = [];
        for (const e of site.entries) {
          expect(e.assignments).toHaveLength(2);
          const lenA = e.assignments.find((a) => a.slot.encoding === "dynamicArrayLength");
          const valA = e.assignments.find((a) => a.slot.encoding === "static");
          expect(lenA).toBeDefined();
          expect(valA).toBeDefined();
          const n = lenA!.value;
          const v = valA!.value;
          expect(n >= 2n && n <= 24n).toBe(true);
          expect(v >= 0n && v <= M - 1n).toBe(true);
          expect(v).toBe(ceilOracle(M, n));
          expect(n * v).toBeGreaterThanOrEqual(M);
          expect((n * v) % M).toBeLessThan(n);
          lens.push(n);
        }
        expect(new Set(lens).size).toBe(lens.length);
        expect(lens).toEqual(Array.from({ length: 23 }, (_, i) => BigInt(i + 2)));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(3) slots carry the ABI position and head offset of their parameters", () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        const b = build(c);
        const { site } = run(b);
        const arrOff = oracleHeadOffset(b.inputs, c.arrayPos);
        const valOff = oracleHeadOffset(b.inputs, c.valuePos);
        for (const e of site.entries) {
          const lenA = e.assignments.find((a) => a.slot.encoding === "dynamicArrayLength")!;
          const valA = e.assignments.find((a) => a.slot.encoding === "static")!;
          expect(lenA.slot.paramIndex).toBe(c.arrayPos);
          expect(lenA.slot.headOffset).toBe(arrOff);
          expect(valA.slot.paramIndex).toBe(c.valuePos);
          expect(valA.slot.headOffset).toBe(valOff);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(4) BEC batchTransfer(address[] _receivers, uint256 _value)", () => {
    const abi: AbiFunction[] = [
      {
        type: "function",
        name: "batchTransfer",
        inputs: [
          { name: "_receivers", type: "address[]" },
          { name: "_value", type: "uint256" },
        ],
        stateMutability: "nonpayable",
      },
    ];
    const site: ArithmeticSite = {
      id: "bec",
      function: "batchTransfer",
      operator: "*",
      operands: [
        { kind: "arrayLength", name: "_receivers", type: "uint256" },
        { kind: "param", name: "_value", type: "uint256" },
      ],
      location: { file: "BEC.sol", line: 1, column: 1 },
    };
    const r = generateTargets({ schemaVersion: "1", contract: "BEC", sites: [site] }, abi);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const entries = r.value.sites[0]!.entries;
    expect(entries).toHaveLength(23);
    const lens = entries.map((e) => e.assignments[0]!.value);
    expect(lens).toEqual(Array.from({ length: 23 }, (_, i) => BigInt(i + 2)));
    const first = entries[0]!;
    expect(first.assignments[0]!.value).toBe(2n);
    expect(first.assignments[1]!.value).toBe(1n << 255n);
    expect(lens.filter((n) => n >= 2n && n <= 20n)).toHaveLength(19);
    for (const e of entries) {
      expect(e.assignments[0]!.slot).toEqual({ encoding: "dynamicArrayLength", paramIndex: 0, headOffset: 4 });
      expect(e.assignments[1]!.slot).toEqual({ encoding: "static", paramIndex: 1, headOffset: 36 });
    }
  });

  it("(5) length times a known constant k follows the x * k window on the length slot (no 2..24 cap, no pairing)", () => {
    // Design: `x * k` -> window ceil(M/k)-2 .. +2 on x. The array length is x. The design does
    // not cap that window to 2..24 for this form; the arrayLenTimesValue rule needs a value operand.
    const kArb = fc.record({ j: fc.integer({ min: 1, max: 255 }), r: fc.bigInt({ min: 0n, max: (1n << 256n) - 1n }), kind: fc.integer({ min: 0, max: 2 }) });
    fc.assert(
      fc.property(caseArb, kArb, ({ ...c }, { j, r, kind }) => {
        const M = 1n << 256n; // known type uint256 and length uint256
        const k = kind === 0 ? 2n + (r % 63n) : kind === 1 ? (1n << BigInt(j)) + (r % 3n) - 1n : 2n + (r % (M - 2n));
        const kk = k < 2n ? 2n : k;
        const b = build(c, "known", kk);
        const { site } = run(b);
        const ctr = ceilOracle(M, kk);
        const expected: bigint[] = [];
        for (let v = ctr - 2n; v <= ctr + 2n; v++) if (v >= 0n && v <= M - 1n) expected.push(v);
        expect(site.entries.map((e) => e.assignments.length)).toEqual(expected.map(() => 1));
        expect(site.entries.map((e) => e.assignments[0]!.value)).toEqual(expected);
        const off = oracleHeadOffset(b.inputs, c.arrayPos);
        for (const e of site.entries) {
          expect(e.assignments[0]!.slot).toEqual({ encoding: "dynamicArrayLength", paramIndex: c.arrayPos, headOffset: off });
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(6) is deterministic: two runs give deepEqual output", () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        const b = build(c);
        const { plan, again } = run(b);
        expect(again.ok).toBe(true);
        if (again.ok) expect(again.value).toEqual(plan);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
