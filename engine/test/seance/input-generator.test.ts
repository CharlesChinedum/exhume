import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { generateTargets } from "../../src/seance/input-generator.js";
import type {
  AbiFunction,
  ArithmeticSite,
  AutopsyReport,
  Operand,
  SiteTargets,
  TargetPlan,
} from "../../src/seance/types.js";

const loc = { file: "T.sol", line: 1, column: 1 };
const fn = (name: string, inputs: [string, string][]): AbiFunction => ({
  type: "function",
  name,
  inputs: inputs.map(([n, type]) => ({ name: n, type })),
  stateMutability: "nonpayable",
});
const known = (value: bigint | number, type = "uint256"): Operand => ({ kind: "known", value: String(value), type });
const param = (name: string, type = "uint256"): Operand => ({ kind: "param", name, type });
const site = (
  id: string,
  func: string,
  operator: ArithmeticSite["operator"],
  a: Operand,
  b: Operand,
  precondition?: ArithmeticSite["precondition"],
): ArithmeticSite => ({
  id,
  function: func,
  operator,
  operands: [a, b],
  location: loc,
  ...(precondition && { precondition }),
});
const report = (...sites: ArithmeticSite[]): AutopsyReport => ({ schemaVersion: "1", contract: "T", sites });
const gen = (sites: ArithmeticSite[], abi: AbiFunction[]): TargetPlan => {
  const r = generateTargets(report(...sites), abi);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const one = (s: ArithmeticSite, abi: AbiFunction[]): SiteTargets => gen([s], abi).sites[0] as SiteTargets;
const vals = (t: SiteTargets) => t.entries.map((e) => e.assignments.map((a) => a.value));
const flat = (t: SiteTargets) => t.entries.map((e) => e.assignments[0]!.value);

const TOKEN_ABI = [fn("f", [["x", "uint256"]]), fn("g", [["x", "uint8"]])];
const M256 = 1n << 256n;

describe("array length times value (BEC)", () => {
  const abi = [fn("batchTransfer", [["_receivers", "address[]"], ["_value", "uint256"]])];
  const s = site("s1", "batchTransfer", "*", { kind: "arrayLength", name: "_receivers", type: "uint256" }, param("_value"));
  const t = one(s, abi);

  it("has 23 paired entries n = 2..24", () => {
    expect(t.entries).toHaveLength(23);
    t.entries.forEach((e, i) => {
      const n = BigInt(i + 2);
      expect(e.assignments).toHaveLength(2);
      const [len, val] = e.assignments;
      expect(len!.value).toBe(n);
      expect(n * val!.value).toBeGreaterThanOrEqual(M256);
      expect((n * val!.value) % M256).toBeLessThan(n);
    });
  });

  it("uses dynamicArrayLength for param 0 and static for param 1 with correct head offsets", () => {
    const [len, val] = t.entries[0]!.assignments;
    expect(len!.slot).toEqual({ encoding: "dynamicArrayLength", paramIndex: 0, headOffset: 4 });
    expect(val!.slot).toEqual({ encoding: "static", paramIndex: 1, headOffset: 36 });
  });

  it("offsets skip multi-word static params", () => {
    const abi2 = [fn("h", [["pair", "uint256[2]"], ["v", "uint256"]])];
    const r = one(site("s", "h", "+", known(0), param("v")), abi2);
    expect(r.entries[0]!.assignments[0]!.slot.headOffset).toBe(4 + 64);
  });
});

describe("x * k", () => {
  it("k = 5 covers floor/ceil and wraps below k", () => {
    const t = one(site("s", "f", "*", param("x"), known(5)), TOKEN_ABI);
    const c = (M256 + 4n) / 5n;
    const v = flat(t);
    expect(v).toEqual([c - 2n, c - 1n, c, c + 1n, c + 2n]);
    expect(v).toContain(M256 / 5n);
    expect((c * 5n) % M256).toBeLessThan(5n);
    expect(c * 5n).toBeGreaterThanOrEqual(M256);
  });

  it("k = 2^128", () => {
    const v = flat(one(site("s", "f", "*", known(1n << 128n), param("x")), TOKEN_ABI));
    expect(v).toContain(1n << 128n);
    expect(v).toHaveLength(5);
  });

  it("narrower type: uint8 uses M = 256", () => {
    const v = flat(one(site("s", "g", "*", param("x", "uint8"), known(3, "uint8")), TOKEN_ABI));
    expect(v).toContain(86n); // ceil(256/3)
    expect(v.every((x) => x < 256n)).toBe(true);
  });

  it("mixed widths use the narrowest", () => {
    const v = flat(one(site("s", "f", "*", param("x", "uint256"), known(3, "uint128")), TOKEN_ABI));
    const M = 1n << 128n;
    expect(v).toContain((M + 2n) / 3n);
  });
});

describe("a + b and a - b windows", () => {
  const bs = (a: bigint) => flat(one(site("s", "f", "+", known(a), param("x")), TOKEN_ABI));
  it("a = 0", () => expect(bs(0n)).toEqual([M256 - 3n, M256 - 2n, M256 - 1n]));
  it("a = 1", () => expect(bs(1n)).toEqual([M256 - 4n, M256 - 3n, M256 - 2n, M256 - 1n].slice(0, 4).filter((v) => v >= M256 - 4n)));
  it("a = M-1 clamps to 0..2 -> [0, 1, 2]", () => expect(bs(M256 - 1n)).toEqual([0n, 1n, 2n]));
  it("a - b near 0", () => {
    const v = flat(one(site("s", "f", "-", known(0), param("x")), TOKEN_ABI));
    expect(v).toEqual([0n, 1n, 2n]);
    const w = flat(one(site("s", "f", "-", known(1), param("x")), TOKEN_ABI));
    expect(w).toEqual([0n, 1n, 2n, 3n]);
  });
  it("a - b with a at the top clamps", () => {
    const v = flat(one(site("s", "f", "-", known(M256 - 1n), param("x")), TOKEN_ABI));
    expect(v).toEqual([M256 - 3n, M256 - 2n, M256 - 1n]);
  });
});

describe("x * y and x ** y", () => {
  const abi = [fn("p", [["x", "uint256"], ["y", "uint256"]])];
  it("includes (2^128, 2^128), pairs overflow and wrap below min", () => {
    const t = one(site("s", "p", "*", param("x"), param("y")), abi);
    expect(t.entries.length).toBeLessThanOrEqual(64);
    expect(vals(t)).toContainEqual([1n << 128n, 1n << 128n]);
    for (const [x, y] of vals(t) as [bigint, bigint][]) {
      expect(x * y).toBeGreaterThanOrEqual(M256);
      expect((x * y) % M256).toBeLessThan(x < y ? x : y);
    }
    expect(t.entries[0]!.assignments.map((a) => a.slot.paramIndex)).toEqual([0, 1]);
  });

  it("x ** y pairs reach M and include (2, N), (2, N+1), (3, 162)", () => {
    const t = one(site("s", "p", "**", param("x"), param("y")), abi);
    const v = vals(t) as [bigint, bigint][];
    expect(v).toContainEqual([2n, 256n]);
    expect(v).toContainEqual([2n, 257n]);
    expect(v).toContainEqual([3n, 162n]);
    for (const [b, e] of v) expect(b ** e).toBeGreaterThanOrEqual(M256);
    expect(v.length).toBeLessThanOrEqual(64);
  });

  it("uint8 x * y uses N = 8", () => {
    const abi8 = [fn("p", [["x", "uint8"], ["y", "uint8"]])];
    const t = one(site("s", "p", "*", param("x", "uint8"), param("y", "uint8")), abi8);
    expect(vals(t)).toContainEqual([16n, 16n]);
  });
});

describe("cap, empty, unreachable, seeds, determinism", () => {
  it("caps unknown x * y at 64 (255 candidate pairs for uint256)", () => {
    const abi = [fn("p", [["x", "uint256"], ["y", "uint256"]])];
    const t = one(site("s", "p", "*", param("x"), param("y")), abi);
    expect(t.entries).toHaveLength(64);
    expect(new Set(t.entries.map((e) => JSON.stringify(e.assignments.map((a) => a.value.toString())))).size).toBe(64);
  });

  it("empty report gives an empty plan", () => {
    expect(gen([], [])).toEqual({ sites: [], seedSequences: [] });
  });

  it("approve precondition yields an approve seed; transferFrom site is reachable", () => {
    const abi = [
      fn("approve", [["spender", "address"], ["amount", "uint256"]]),
      fn("transferFrom", [["from", "address"], ["to", "address"], ["v", "uint256"]]),
    ];
    const plan = gen([site("s", "transferFrom", "-", known(0), param("v"), [{ kind: "approve" }])], abi);
    expect(plan.sites[0]!.unreachable).toBe(false);
    expect(plan.seedSequences).toHaveLength(1);
    const seq = plan.seedSequences[0]!;
    expect(seq.length).toBeLessThanOrEqual(10);
    expect(seq.every((c) => c.function === "approve")).toBe(true);
    expect(plan.sites[0]!.entries[0]!.assignments[0]!.slot.headOffset).toBe(4 + 64);
  });

  it("constructor-balance needs no calls; no precondition needs none", () => {
    const plan = gen([site("s", "f", "+", known(0), param("x"), [{ kind: "constructor-balance" }])], TOKEN_ABI);
    expect(plan.seedSequences).toEqual([]);
    expect(plan.sites[0]!.unreachable).toBe(false);
  });

  it("unresolvable seed marks the site unreachable but still gives targets", () => {
    const plan = gen([site("s", "f", "*", param("x"), known(5), [{ kind: "approve" }, { kind: "transfer" }])], TOKEN_ABI);
    expect(plan.sites[0]!.unreachable).toBe(true);
    expect(plan.sites[0]!.entries.length).toBeGreaterThanOrEqual(1);
  });

  it("seed sequences never exceed 10 calls with both approve and transfer", () => {
    const abi = [
      ...TOKEN_ABI,
      fn("approve", [["s", "address"], ["a", "uint256"]]),
      fn("transfer", [["to", "address"], ["a", "uint256"]]),
    ];
    const plan = gen([site("s", "f", "*", param("x"), known(5), [{ kind: "approve" }, { kind: "transfer" }])], abi);
    expect(plan.seedSequences[0]!.length).toBeLessThanOrEqual(10);
    expect(plan.sites[0]!.unreachable).toBe(false);
  });

  it("operand that cannot be mapped to a slot still gets one entry", () => {
    const t = one(site("s", "f", "*", { kind: "unknown", type: "uint256" }, known(5)), TOKEN_ABI);
    expect(t.entries).toEqual([{ assignments: [] }]);
  });

  it("is deterministic", () => {
    const abi = [fn("p", [["x", "uint256"], ["y", "uint256"]])];
    const r = report(site("a", "p", "*", param("x"), param("y")), site("b", "p", "**", param("x"), param("y")));
    expect(generateTargets(r, abi)).toEqual(generateTargets(r, abi));
  });

  it("rejects a site naming a function absent from the ABI", () => {
    const r = generateTargets(report(site("s", "nope", "+", known(0), param("x"))), TOKEN_ABI);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTOPSY_REJECTED");
  });
});

describe("arithmetic contract (fast-check)", () => {
  const widths = [8, 16, 32, 64, 128, 256];
  it("x * k: some value overflows and wraps below k", () => {
    fc.assert(
      fc.property(fc.constantFrom(...widths), fc.bigInt({ min: 2n, max: (1n << 256n) - 1n }), (N, raw) => {
        const M = 1n << BigInt(N);
        const k = 2n + (raw % (M - 2n));
        const type = `uint${N}`;
        const t = one(site("s", "f", "*", param("x", type), known(k, type)), [fn("f", [["x", type]])]);
        const v = flat(t);
        expect(v.length).toBeLessThanOrEqual(5);
        expect(v.some((x) => x * k >= M && (x * k) % M < k)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("array length pairs: n * v >= M and wrapped product < n", () => {
    fc.assert(
      fc.property(fc.constantFrom(...widths), (N) => {
        const M = 1n << BigInt(N);
        const type = `uint${N}`;
        const abi = [fn("b", [["r", "address[]"], ["v", type]])];
        const t = one(site("s", "b", "*", { kind: "arrayLength", name: "r", type }, param("v", type)), abi);
        for (const e of t.entries) {
          const n = e.assignments[0]!.value;
          const v = e.assignments[1]!.value;
          expect(n * v).toBeGreaterThanOrEqual(M);
          expect((n * v) % M).toBeLessThan(n);
        }
      }),
      { numRuns: 30 },
    );
  });
});
