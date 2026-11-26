import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { loadAbi } from "../../src/seance/abi.js";
import {
  MAX_AUTOPSY_BYTES,
  parseAutopsyReport,
  serializeAutopsyReport,
} from "../../src/seance/autopsy-contract.js";
import type { AbiFunction, AutopsyReport, SeanceError } from "../../src/seance/types.js";

// 0.4.19-style ABI: no stateMutability, legacy constant/payable flags.
const abiRes = loadAbi([
  { constant: false, inputs: [{ name: "_receivers", type: "address[]" }, { name: "_value", type: "uint256" }], name: "batchTransfer", outputs: [{ name: "", type: "bool" }], payable: false, type: "function" },
  { constant: false, inputs: [{ name: "_to", type: "address" }, { name: "_value", type: "uint256" }], name: "transfer", outputs: [{ name: "", type: "bool" }], payable: false, type: "function" },
  { inputs: [], payable: false, type: "constructor" },
  { anonymous: false, inputs: [], name: "Transfer", type: "event" },
]);
if (!abiRes.ok) throw new Error("abi fixture");
const abi: AbiFunction[] = abiRes.value;

const bec: AutopsyReport = {
  schemaVersion: "1",
  contract: "BecToken",
  sites: [
    {
      id: "batchTransfer:cnt*_value",
      function: "batchTransfer",
      operator: "*",
      operands: [
        { kind: "arrayLength", name: "_receivers", type: "uint256" },
        { kind: "param", name: "_value", type: "uint256" },
      ],
      location: { file: "BecToken.sol", line: 257, column: 17 },
      precondition: [{ kind: "constructor-balance", hint: "owner holds supply" }],
    },
    {
      id: "transfer:sub",
      function: "transfer",
      operator: "-",
      operands: [{ kind: "unknown", type: "uint256" }, { kind: "known", value: "1", type: "uint8" }],
      location: { file: "BecToken.sol", line: 10, column: 3 },
    },
  ],
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function rejected(text: string): { error: SeanceError; details: any } {
  const r = parseAutopsyReport(text, abi);
  if (r.ok) throw new Error("expected rejection");
  expect(r.error.code).toBe("AUTOPSY_REJECTED");
  return { error: r.error, details: r.error.details };
}

describe("parseAutopsyReport", () => {
  it("accepts a BEC-like report", () => {
    const r = parseAutopsyReport(JSON.stringify(bec), abi);
    expect(r).toEqual({ ok: true, value: bec });
  });

  it.each(["", "   \n\t "])("rejects empty input %j", (t) => {
    expect(rejected(t).details.reason).toBe("empty");
  });

  it("rejects input over 10 MB and accepts the boundary check by bytes", () => {
    const big = " ".repeat(MAX_AUTOPSY_BYTES) + "{}";
    expect(rejected(big).details.reason).toBe("too-large");
    // multibyte: 2 bytes per char, so half the limit in chars is already over
    const wide = JSON.stringify({ x: "é".repeat(MAX_AUTOPSY_BYTES / 2) });
    expect(rejected(wide).details.reason).toBe("too-large");
  });

  it("rejects invalid JSON with the parser message", () => {
    const d = rejected('{"schemaVersion": "1",').details;
    expect(d.reason).toBe("invalid-json");
    expect(typeof d.parserMessage).toBe("string");
  });

  it("rejects a missing schemaVersion and a non-object document", () => {
    const { schemaVersion: _omit, ...rest } = bec;
    const r = rejected(JSON.stringify(rest));
    expect(r.details.reason).toBe("schema-version-missing");
    expect(r.error.message).toContain("schemaVersion");
    expect(rejected("[]").details.reason).toBe("schema-version-missing");
  });

  it.each([
    ["2", '"2"'],
    [1, "1"],
    [null, "null"],
  ])("rejects unsupported schemaVersion %j and names it", (v, shown) => {
    const r = rejected(JSON.stringify({ ...bec, schemaVersion: v }));
    expect(r.details.reason).toBe("schema-version-unsupported");
    expect(r.details.found).toBe(v);
    expect(r.error.message).toContain(shown);
  });

  it("lists every schema violation with a JSON pointer", () => {
    const bad = clone(bec) as any;
    bad.contract = "";
    bad.sites[0].operator = "/";
    bad.sites[1].location.line = 0;
    bad.extra = true;
    const { details } = rejected(JSON.stringify(bad));
    expect(details.reason).toBe("schema-violations");
    const pointers = details.violations.map((v: any) => v.pointer);
    expect(pointers).toContain("/contract");
    expect(pointers).toContain("/sites/0/operator");
    expect(pointers).toContain("/sites/1/location/line");
    expect(pointers).toContain("");
    expect([...pointers].sort()).toEqual(pointers);
    const keys = details.violations.map((v: any) => JSON.stringify(v));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("names every unknown function once, with site ids", () => {
    const bad = clone(bec);
    const [s0, s1] = bec.sites as [AutopsyReport["sites"][number], AutopsyReport["sites"][number]];
    bad.sites = [
      { ...clone(s0), id: "a", function: "zeta" },
      { ...clone(s1), id: "b", function: "zeta" },
      { ...clone(s1), id: "c", function: "alpha" },
      { ...clone(s1), id: "d", function: "transfer" },
      { ...clone(s1), id: "e", function: "Transfer" }, // event, not a function
    ];
    const { details, error } = rejected(JSON.stringify(bad));
    expect(details.reason).toBe("unknown-functions");
    expect(details.unknownFunctions).toEqual([
      { function: "Transfer", siteIds: ["e"] },
      { function: "alpha", siteIds: ["c"] },
      { function: "zeta", siteIds: ["a", "b"] },
    ]);
    expect(error.message).toMatch(/Transfer.*alpha.*zeta/);
  });

  it.each(["constructor", "fallback", "receive"] as const)("rejects a site in the %s with a specific message", (kind) => {
    const bad = clone(bec);
    bad.sites[0]!.function = kind;
    const { details, error } = rejected(JSON.stringify(bad));
    const msg = `site ${bad.sites[0]!.id} is in the ${kind}, which takes no fuzzable arguments; only ABI functions can be targeted`;
    expect(error.message).toBe(msg);
    expect(details.reason).toBe("unknown-functions");
    expect(details.nonFunctionSites).toEqual([{ siteId: bad.sites[0]!.id, kind, message: msg }]);
    expect(details.unknownFunctions).toEqual([]);
  });

  it("reports every non-function site, sorted by site id", () => {
    const bad = clone(bec);
    bad.sites[0]!.id = "z";
    bad.sites[0]!.function = "constructor";
    bad.sites[1]!.id = "a";
    bad.sites[1]!.function = "fallback";
    const { details } = rejected(JSON.stringify(bad));
    expect(details.nonFunctionSites.map((n: any) => [n.siteId, n.kind])).toEqual([["a", "fallback"], ["z", "constructor"]]);
  });

  it("reports both lists for a mixed document", () => {
    const bad = clone(bec);
    bad.sites[0]!.function = "constructor";
    bad.sites[1]!.function = "nope";
    const { details, error } = rejected(JSON.stringify(bad));
    expect(details.nonFunctionSites).toHaveLength(1);
    expect(details.unknownFunctions).toEqual([{ function: "nope", siteIds: ["transfer:sub"] }]);
    expect(error.message).toContain("is in the constructor");
    expect(error.message).toContain("missing from the legacy ABI: nope");
  });

  it("reports only the version problem when other violations exist too", () => {
    const bad = { ...clone(bec), schemaVersion: "2", contract: "" };
    expect(rejected(JSON.stringify(bad)).details.reason).toBe("schema-version-unsupported");
  });

  it("reports only schema violations when unknown functions exist too", () => {
    const bad = clone(bec);
    bad.contract = "";
    bad.sites[0]!.function = "nope";
    expect(rejected(JSON.stringify(bad)).details.reason).toBe("schema-violations");
  });
});

describe("serializeAutopsyReport", () => {
  it("emits canonical key order regardless of input key order", () => {
    const shuffled = {
      sites: [
        {
          location: { column: 17, line: 257, file: "BecToken.sol" },
          operands: [
            { type: "uint256", name: "_receivers", kind: "arrayLength" },
            { type: "uint256", name: "_value", kind: "param" },
          ],
          precondition: [{ hint: "owner holds supply", kind: "constructor-balance" }],
          operator: "*",
          function: "batchTransfer",
          id: "batchTransfer:cnt*_value",
        },
      ],
      contract: "BecToken",
      schemaVersion: "1",
    } as unknown as AutopsyReport;
    const out = serializeAutopsyReport(shuffled);
    expect(out).toBe(serializeAutopsyReport({ ...bec, sites: [bec.sites[0]!] }));
    const keyOrder = (s: string) => [...s.matchAll(/"(\w+)":/g)].map((m) => m[1]);
    expect(keyOrder(out).slice(0, 4)).toEqual(["schemaVersion", "contract", "sites", "id"]);
    expect(out.endsWith("}\n")).toBe(true);
  });

  it("round-trips and is idempotent", () => {
    const s1 = serializeAutopsyReport(bec);
    const parsed = parseAutopsyReport(s1, abi);
    expect(parsed).toEqual({ ok: true, value: bec });
    if (!parsed.ok) return;
    expect(serializeAutopsyReport(parsed.value)).toBe(s1);
  });

  it("round-trips generated reports (minimal property check)", () => {
    const operand = fc.oneof(
      fc.record({ kind: fc.constant("known" as const), value: fc.bigInt({ min: 0n, max: 2n ** 256n }).map(String), type: fc.constant("uint256") }),
      fc.record({ kind: fc.constant("param" as const), name: fc.string({ minLength: 1 }), type: fc.constant("uint8") }),
      fc.record({ kind: fc.constant("unknown" as const), type: fc.constant("uint256") }),
    );
    const site = fc.record(
      {
        id: fc.string({ minLength: 1 }),
        function: fc.constantFrom("transfer", "batchTransfer"),
        operator: fc.constantFrom("+", "-", "*", "**" as const),
        operands: fc.tuple(operand, operand),
        location: fc.record({ file: fc.string({ minLength: 1 }), line: fc.integer({ min: 1, max: 9999 }), column: fc.integer({ min: 1, max: 200 }) }),
      },
      { requiredKeys: ["id", "function", "operator", "operands", "location"] },
    );
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.array(site, { maxLength: 4 }), (contract, sites) => {
        const r = { schemaVersion: "1", contract, sites } as AutopsyReport;
        const s = serializeAutopsyReport(r);
        const p = parseAutopsyReport(s, abi);
        expect(p).toEqual({ ok: true, value: r });
        expect(serializeAutopsyReport((p as { value: AutopsyReport }).value)).toBe(s);
      }),
      { numRuns: 50 },
    );
  });
});
