import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { loadAbi } from "../../src/seance/abi.js";

const legacy = [
  { constant: true, inputs: [], name: "totalSupply", outputs: [{ name: "", type: "uint256" }], payable: false, type: "function" },
  { constant: false, inputs: [{ name: "to", type: "address" }], name: "transfer", outputs: [], payable: false, type: "function" },
  { constant: false, inputs: [], name: "buy", outputs: [], payable: true, type: "function" },
  { constant: true, inputs: [], name: "weird", outputs: [], payable: true, type: "function" },
  { inputs: [], payable: true, type: "constructor" },
  { payable: true, type: "fallback" },
  { anonymous: false, inputs: [], name: "Transfer", type: "event" },
];

describe("loadAbi", () => {
  it("normalises a 0.4.19-style ABI", () => {
    const r = loadAbi(legacy);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((e) => [e.type, e.name, e.stateMutability])).toEqual([
      ["function", "totalSupply", "view"],
      ["function", "transfer", "nonpayable"],
      ["function", "buy", "payable"],
      ["function", "weird", "payable"],
      ["constructor", undefined, "payable"],
      ["fallback", undefined, "payable"],
    ]);
    expect(r.value[5]?.inputs).toEqual([]);
  });

  it("filters a 0.8-style ABI and keeps existing stateMutability", () => {
    const r = loadAbi([
      { type: "constructor", inputs: [], stateMutability: "nonpayable" },
      { type: "receive", stateMutability: "payable" },
      { type: "fallback", stateMutability: "nonpayable" },
      { type: "function", name: "a", inputs: [], outputs: [], stateMutability: "pure" },
      { type: "error", name: "E", inputs: [] },
      { type: "event", name: "Ev", inputs: [] },
      { type: "function", name: "b", inputs: [], stateMutability: "view", constant: false },
    ]);
    expect(r.ok && r.value.map((e) => [e.type, e.stateMutability])).toEqual([
      ["constructor", "nonpayable"],
      ["receive", "payable"],
      ["fallback", "nonpayable"],
      ["function", "pure"],
      ["function", "view"],
    ]);
  });

  it("skips unknown types silently", () => {
    const r = loadAbi([{ type: "mystery" }]);
    expect(r).toEqual({ ok: true, value: [] });
  });

  it.each([
    ["non-array", { type: "function" }, /array/],
    ["non-object entry", [1], /ABI entry 0/],
    ["null entry", [null], /ABI entry 0/],
    ["array entry", [[]], /ABI entry 0/],
    ["non-string type", [{ type: "event" }, { type: 5 }], /ABI entry 1/],
    ["missing type", [{ name: "x" }], /ABI entry 0/],
    ["function without name", [{ type: "fallback" }, { type: "function", inputs: [] }], /ABI entry 1/],
    ["non-array inputs", [{ type: "function", name: "x", inputs: 3 }], /ABI entry 0/],
    ["bad stateMutability", [{ type: "function", name: "x", stateMutability: "pure!" }], /ABI entry 0/],
  ])("rejects %s with INVALID_INPUT", (_n, input, msg) => {
    const r = loadAbi(input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_INPUT");
      expect(r.error.message).toMatch(msg);
    }
  });

  it("property: output only has allowed types, always has stateMutability, length = kept entries", () => {
    const allowed = ["function", "constructor", "fallback", "receive"];
    const entry = fc.record(
      {
        type: fc.constantFrom(...allowed, "event", "error", "weird"),
        name: fc.constant("n"),
        payable: fc.boolean(),
        constant: fc.boolean(),
        stateMutability: fc.constantFrom("pure", "view", "nonpayable", "payable"),
      },
      { requiredKeys: ["type", "name"] },
    );
    fc.assert(
      fc.property(fc.array(entry), (abi) => {
        const r = loadAbi(abi);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value).toHaveLength(abi.filter((e) => allowed.includes(e.type)).length);
        for (const e of r.value) {
          expect(allowed).toContain(e.type);
          expect(["pure", "view", "nonpayable", "payable"]).toContain(e.stateMutability);
        }
      }),
    );
  });
});
