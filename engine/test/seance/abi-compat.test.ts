import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAbi } from "../../src/seance/abi.js";
import { canonicalType, compareAbis, functionKey, readPortArtifact } from "../../src/seance/abi-compat.js";
import type { AbiFunction, AbiParam } from "../../src/seance/types.js";

const abi = (raw: unknown[]): AbiFunction[] => {
  const r = loadAbi(raw);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const fn = (name: string, types: string[], extra: Record<string, unknown> = {}) => ({
  type: "function",
  name,
  inputs: types.map((type, i) => ({ name: `a${i}`, type })),
  outputs: [],
  stateMutability: "nonpayable",
  ...extra,
});

const base = () => [fn("transfer", ["address", "uint256"]), fn("balanceOf", ["address"], { stateMutability: "view" })];

describe("compareAbis", () => {
  it("identical ABIs pass, regardless of order", () => {
    expect(compareAbis(abi(base()), abi(base())).ok).toBe(true);
    expect(compareAbis(abi(base()), abi(base().reverse())).ok).toBe(true);
  });

  it("ignores stateMutability, outputs, parameter names", () => {
    const port = [
      fn("transfer", ["address", "uint256"], { outputs: [{ name: "", type: "bool" }] }),
      fn("balanceOf", ["address"], { stateMutability: "nonpayable" }),
    ];
    expect(compareAbis(abi(base()), abi(port)).ok).toBe(true);
    // legacy `constant` vs 0.8 `view`
    const legacy = [fn("f", [], { stateMutability: undefined, constant: true })];
    expect(compareAbis(abi(legacy), abi([fn("f", [], { stateMutability: "view" })])).ok).toBe(true);
  });

  it("ignores events, errors, constructor, fallback and receive", () => {
    const legacy = [
      ...base(),
      { type: "event", name: "Transfer", inputs: [] },
      { type: "constructor", inputs: [{ name: "x", type: "uint256" }], stateMutability: "nonpayable" },
      { type: "fallback", stateMutability: "payable" },
    ];
    const port = [
      ...base(),
      { type: "error", name: "Boom", inputs: [] },
      { type: "receive", stateMutability: "payable" },
      { type: "constructor", inputs: [], stateMutability: "nonpayable" },
    ];
    expect(compareAbis(abi(legacy), abi(port)).ok).toBe(true);
  });

  it("a removed function is reported as missing in port", () => {
    const r = compareAbis(abi(base()), abi([base()[1]!]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.message).toContain("missing in port: transfer(address,uint256)");
    expect(r.error.message).not.toContain("extra in port");
    expect(r.error.details).toEqual({ onlyInLegacy: ["transfer(address,uint256)"], onlyInPort: [] });
  });

  it("an added function is reported as extra in port", () => {
    const r = compareAbis(abi(base()), abi([...base(), fn("burn", ["uint256"])]));
    expect(!r.ok && r.error.message).toContain("extra in port: burn(uint256)");
    expect(!r.ok && r.error.details).toEqual({ onlyInLegacy: [], onlyInPort: ["burn(uint256)"] });
  });

  it("a changed input type shows on both sides, sorted", () => {
    const port = [fn("transfer", ["address", "uint128"]), fn("balanceOf", ["address"])];
    const r = compareAbis(abi(base()), abi(port));
    expect(!r.ok && r.error.details).toEqual({
      onlyInLegacy: ["transfer(address,uint256)"],
      onlyInPort: ["transfer(address,uint128)"],
    });
    expect(!r.ok && r.error.message).toBe(
      "port ABI differs from legacy ABI: missing in port: transfer(address,uint256); extra in port: transfer(address,uint128)",
    );
  });

  it("parameter order matters", () => {
    const r = compareAbis(abi([fn("f", ["uint256", "address"])]), abi([fn("f", ["address", "uint256"])]));
    expect(r.ok).toBe(false);
  });

  it("overloads are separate keys", () => {
    const both = [fn("f", ["uint256"]), fn("f", ["address"])];
    expect(compareAbis(abi(both), abi([...both].reverse())).ok).toBe(true);
    const r = compareAbis(abi(both), abi([fn("f", ["uint256"])]));
    expect(!r.ok && r.error.details).toEqual({ onlyInLegacy: ["f(address)"], onlyInPort: [] });
  });

  it("is a multiset compare: duplicate signatures count", () => {
    const one = [fn("f", ["uint256"])];
    const two = [fn("f", ["uint256"]), fn("f", ["uint256"], { stateMutability: "view" })];
    expect(compareAbis(abi(two), abi(two)).ok).toBe(true);
    const r = compareAbis(abi(two), abi(one));
    expect(!r.ok && r.error.details).toEqual({ onlyInLegacy: ["f(uint256)"], onlyInPort: [] });
    const r2 = compareAbis(abi(one), abi(two));
    expect(!r2.ok && r2.error.details).toEqual({ onlyInLegacy: [], onlyInPort: ["f(uint256)"] });
  });
});

describe("canonical types", () => {
  const tuple = (type: string, components: AbiParam[]): AbiParam => ({ name: "t", type, components });

  it("expands tuples, nested tuples and array suffixes", () => {
    const inner = tuple("tuple", [
      { name: "a", type: "uint256" },
      { name: "b", type: "bytes32[2]" },
    ]);
    expect(canonicalType(inner)).toBe("(uint256,bytes32[2])");
    expect(canonicalType({ ...inner, type: "tuple[]" })).toBe("(uint256,bytes32[2])[]");
    expect(canonicalType({ ...inner, type: "tuple[3][]" })).toBe("(uint256,bytes32[2])[3][]");
    const outer = tuple("tuple", [{ name: "x", type: "address" }, { ...inner, name: "y" }]);
    expect(canonicalType(outer)).toBe("(address,(uint256,bytes32[2]))");
    expect(canonicalType({ name: "a", type: "address[]" })).toBe("address[]");
    expect(canonicalType({ name: "e", type: "tuple", components: [] })).toBe("()");
  });

  it("normalises uint/int aliases", () => {
    expect(canonicalType({ name: "", type: "uint" })).toBe("uint256");
    expect(canonicalType({ name: "", type: "int[]" })).toBe("int256[]");
    expect(canonicalType({ name: "", type: "uint8" })).toBe("uint8");
    expect(canonicalType({ name: "", type: "uint256" })).toBe("uint256");
  });

  it("functionKey and tuple/array comparisons", () => {
    const p = { name: "p", type: "tuple[]", components: [{ name: "a", type: "address" }, { name: "v", type: "uint256" }] };
    const f = abi([{ type: "function", name: "batch", inputs: [p, { name: "n", type: "uint256[]" }], outputs: [], stateMutability: "nonpayable" }]);
    expect(functionKey(f[0]!)).toBe("batch((address,uint256)[],uint256[])");
    const g = abi([
      {
        type: "function",
        name: "batch",
        inputs: [{ ...p, components: [{ name: "a", type: "address" }, { name: "v", type: "uint128" }] }, { name: "n", type: "uint256[]" }],
        outputs: [],
        stateMutability: "nonpayable",
      },
    ]);
    const r = compareAbis(f, g);
    expect(!r.ok && r.error.details).toEqual({
      onlyInLegacy: ["batch((address,uint256)[],uint256[])"],
      onlyInPort: ["batch((address,uint128)[],uint256[])"],
    });
  });
});

describe("readPortArtifact", () => {
  it("reads the ABI and reports missing files", () => {
    const out = mkdtempSync(join(tmpdir(), "exhume-port-"));
    try {
      const miss = readPortArtifact(out, "T");
      expect(!miss.ok && miss.error.code).toBe("BUILD_FAILED");
      if (!miss.ok) expect(miss.error.message).toContain(join(out, "PortT.sol", "T.json"));
      mkdirSync(join(out, "PortT.sol"));
      writeFileSync(join(out, "PortT.sol", "T.json"), JSON.stringify({ abi: base() }));
      const r = readPortArtifact(out, "T");
      expect(r.ok && r.value.map((f) => f.name)).toEqual(["transfer", "balanceOf"]);
      writeFileSync(join(out, "PortT.sol", "T.json"), JSON.stringify({ abi: "nope" }));
      expect(readPortArtifact(out, "T").ok).toBe(false);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
