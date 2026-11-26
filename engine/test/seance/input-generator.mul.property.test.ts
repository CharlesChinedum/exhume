/**
 * Task 7.2, Property 13: Multiplication targets overflow and wrap.
 *
 * **Validates: Requirements 6.2, 6.6, 6.13**
 *
 * The oracle below is independent of the generator: it recomputes the expected
 * window from M and k with plain bigint arithmetic.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { generateTargets } from "../../src/seance/input-generator.js";
import type { AbiFunction, ArithmeticSite, AutopsyReport, Operand } from "../../src/seance/types.js";

const NUM_RUNS = 300;

type Layout = "xk" | "kx" | "mixedWide" | "mixedNarrow";

const uintT = (n: number) => `uint${n}`;

function buildCase(n: number, k: bigint, layout: Layout, kType?: string) {
  const abi: AbiFunction[] = [];
  let xType = uintT(n);
  let kt = uintT(n);
  if (layout === "mixedWide") xType = "uint256"; // x is uint256, k (narrowest) is uintN
  if (layout === "mixedNarrow") kt = "uint256"; // x is uintN (narrowest), k is uint256
  if (kType) kt = kType;
  abi.push({
    type: "function",
    name: "foo",
    inputs: [{ name: "x", type: xType }],
    stateMutability: "nonpayable",
  });
  const x: Operand = { kind: "param", name: "x", type: xType };
  const kk: Operand = { kind: "known", value: k.toString(10), type: kt };
  const site: ArithmeticSite = {
    id: "s1",
    function: "foo",
    operator: "*",
    operands: layout === "kx" ? [kk, x] : [x, kk],
    location: { file: "T.sol", line: 1, column: 1 },
  };
  const report: AutopsyReport = { schemaVersion: "1", contract: "T", sites: [site] };
  return { report, abi };
}

function run(n: number, k: bigint, layout: Layout, kType?: string) {
  const { report, abi } = buildCase(n, k, layout, kType);
  const r = generateTargets(report, abi);
  if (!r.ok) throw new Error(`generateTargets failed: ${r.error.message}`);
  const t = r.value.sites[0];
  if (!t) throw new Error("no site");
  return { plan: r.value, site: t, again: generateTargets(report, abi) };
}

/** Independent oracle: ceil(M/k) via floor + remainder, window by filtering. */
function oracleWindow(M: bigint, k: bigint): { c: bigint; expected: bigint[] } {
  const c = M / k + (M % k === 0n ? 0n : 1n);
  const expected: bigint[] = [];
  for (let v = c - 2n; v <= c + 2n; v++) if (v >= 0n && v <= M - 1n) expected.push(v);
  return { c, expected };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const widthArb = fc.integer({ min: 1, max: 32 }).map((i) => i * 8);
const seedArb = fc.bigInt({ min: 0n, max: (1n << 256n) - 1n });
const clampK = (k: bigint, M: bigint) => (k < 2n ? 2n : k > M - 1n ? M - 1n : k);

/** (N, k) with 2 <= k <= M-1. */
const nkArb = fc
  .record({ n: widthArb, kind: fc.integer({ min: 0, max: 6 }), r: seedArb, d: fc.integer({ min: -1, max: 1 }) })
  .map(({ n, kind, r, d }) => {
    const M = 1n << BigInt(n);
    let k: bigint;
    switch (kind) {
      case 0:
        k = 2n + (r % 63n); // small 2..64
        break;
      case 1:
      case 2: {
        const j = 1n + (r % BigInt(n - 1)); // 1..N-1
        k = (1n << j) + BigInt(d);
        break;
      }
      case 3:
      case 4:
        k = 2n + (r % (M - 2n)); // arbitrary
        break;
      case 5:
        k = d < 0 ? 2n : d === 0 ? M - 1n : M / 2n;
        break;
      default:
        k = (r % 2n === 0n ? 2n : M - 1n) - (r % 3n === 0n ? 1n : 0n);
    }
    return { n, M, k: clampK(k, M) };
  });

const layoutArb = fc.constantFrom<Layout>("xk", "kx", "mixedWide", "mixedNarrow");

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("Property 13: Multiplication targets overflow and wrap", () => {
  it("(1,2) ok, 1..64 entries, values in [0, M-1], window equals the oracle set in ascending order", () => {
    fc.assert(
      fc.property(nkArb, layoutArb, ({ n, M, k }, layout) => {
        const { site } = run(n, k, layout);
        expect(site.entries.length).toBeGreaterThanOrEqual(1);
        expect(site.entries.length).toBeLessThanOrEqual(64);
        const xs: bigint[] = [];
        for (const e of site.entries) {
          expect(e.assignments).toHaveLength(1);
          const v = e.assignments[0]!.value;
          expect(typeof v).toBe("bigint");
          expect(v >= 0n && v <= M - 1n).toBe(true);
          xs.push(v);
        }
        const { c, expected } = oracleWindow(M, k);
        expect(xs).toEqual(expected);
        expect(new Set(xs).size).toBe(xs.length);
        expect(xs).toContain(c);
        expect(xs).toContain(M / k); // floor(M/k)
        expect(xs.length).toBeLessThanOrEqual(5);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(3) some x overflows and wraps below k; ceil(M/k) always does", () => {
    fc.assert(
      fc.property(nkArb, layoutArb, ({ n, M, k }, layout) => {
        const { site } = run(n, k, layout);
        const xs = site.entries.map((e) => e.assignments[0]!.value);
        expect(xs.some((x) => x * k >= M && (x * k) % M < k)).toBe(true);
        const c = M / k + (M % k === 0n ? 0n : 1n);
        expect(c * k).toBeGreaterThanOrEqual(M);
        expect(c * k - M).toBeLessThan(k); // oracle sanity: ceil always wraps below k
        expect(xs).toContain(c);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(4) k = 2^j: the wrapped product of ceil(M/k) is exactly 0", () => {
    fc.assert(
      fc.property(widthArb, fc.nat(), layoutArb, (n, jr, layout) => {
        const j = 1 + (jr % (n - 1)); // 1..N-1 so that 2 <= k < M
        const k = 1n << BigInt(j);
        const M = 1n << BigInt(n);
        const { site } = run(n, k, layout);
        const xs = site.entries.map((e) => e.assignments[0]!.value);
        const c = M / k; // exact
        expect(xs).toContain(c);
        expect((c * k) % M).toBe(0n);
        expect(xs.some((x) => x * k >= M && (x * k) % M === 0n)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("(5) the narrowest operand type decides M, whatever the other operand is", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 31 }).map((i) => i * 8),
        seedArb,
        fc.constantFrom<Layout>("mixedWide", "mixedNarrow"),
        (n, r, layout) => {
          const M = 1n << BigInt(n);
          const k = 2n + (r % (M - 2n));
          const { site } = run(n, k, layout);
          const xs = site.entries.map((e) => e.assignments[0]!.value);
          expect(xs.every((x) => x <= M - 1n)).toBe(true);
          expect(xs).toEqual(oracleWindow(M, k).expected);
        },
      ),
      { numRuns: NUM_RUNS },
    );
    // uint256 x with uint8 k: M = 2^8.
    const { site } = run(8, 3n, "mixedWide");
    expect(site.entries.map((e) => e.assignments[0]!.value)).toEqual([84n, 85n, 86n, 87n, 88n]);
  });

  it("(6) is deterministic: two calls give deepEqual output", () => {
    fc.assert(
      fc.property(nkArb, layoutArb, ({ n, k }, layout) => {
        const { plan, again } = run(n, k, layout);
        expect(again.ok).toBe(true);
        if (again.ok) expect(again.value).toEqual(plan);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("k >= M is out of the rule's domain (design: 1 < k < 2^N): the generator does not throw and stays in range", () => {
    // Design Property 13 restricts k to 1 < k < 2^N. For k >= M the implementation still
    // applies the window around ceil(M/k) = 1, clamped to [0, M-1].
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 31 }).map((i) => i * 8), fc.bigInt({ min: 0n, max: 1n << 40n }), (n, extra) => {
        const M = 1n << BigInt(n);
        const k = M + extra;
        const { site } = run(n, k, "xk", "uint256");
        expect(site.entries.length).toBeGreaterThanOrEqual(1);
        expect(site.entries.length).toBeLessThanOrEqual(64);
        for (const e of site.entries) {
          const v = e.assignments[0]!.value;
          expect(v >= 0n && v <= M - 1n).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Property 13: hand-checked table", () => {
  const M = (n: number) => 1n << BigInt(n);
  const around = (c: bigint) => [c - 2n, c - 1n, c, c + 1n, c + 2n];
  const table: [string, number, bigint, bigint[]][] = [
    ["(256, 5)", 256, 5n, around(23158417847463239084714197001737581570653996933128112807891516801582625927988n)],
    ["(256, 3)", 256, 3n, around(38597363079105398474523661669562635951089994888546854679819194669304376546646n)],
    ["(8, 3)", 8, 3n, [84n, 85n, 86n, 87n, 88n]],
    ["(8, 255)", 8, 255n, [0n, 1n, 2n, 3n, 4n]],
    ["(16, 7)", 16, 7n, [9361n, 9362n, 9363n, 9364n, 9365n]],
    ["(256, 2^128)", 256, 1n << 128n, around(1n << 128n)],
    ["(256, 2^255)", 256, 1n << 255n, [0n, 1n, 2n, 3n, 4n]],
    ["(256, M-1)", 256, M(256) - 1n, [0n, 1n, 2n, 3n, 4n]],
    ["(256, 2)", 256, 2n, around(1n << 255n)],
    ["(256, 10)", 256, 10n, around(11579208923731619542357098500868790785326998466564056403945758400791312963994n)],
  ];

  it.each(table)("%s", (_label, n, k, expected) => {
    const { site } = run(n, k, "xk");
    expect(site.entries.map((e) => e.assignments[0]!.value)).toEqual(expected);
    const m = M(n);
    const c = expected[2]!;
    expect(c * k).toBeGreaterThanOrEqual(m);
    expect((c * k) % m).toBeLessThan(k);
  });
});
