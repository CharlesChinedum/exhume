import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMEOUT_SECONDS,
  INPUT_FIELD_ORDER,
  MAX_SOURCE_BYTES,
  validateInput,
} from "../../src/seance/inputs.js";

const becLike = (): Record<string, unknown> => ({
  contractName: "BecToken",
  legacySource: "pragma solidity ^0.4.19; contract BecToken {}",
  portSource: "pragma solidity ^0.8.28; contract BecToken {}",
  autopsyReport: '{"schemaVersion":"1","contract":"BecToken","sites":[]}',
  legacySolcVersion: "0.4.19",
  legacyOptimizer: false,
  onChainRuntimeCode: "0x6060604052",
});

function fail(raw: unknown) {
  const r = validateInput(raw);
  if (r.ok) throw new Error("expected failure");
  return r.error;
}
const invalidWith = (patch: Record<string, unknown>) => fail({ ...becLike(), ...patch });
const fieldsOf = (e: { details?: unknown }) => (e.details as { fields: string[] }).fields;

describe("validateInput: valid input", () => {
  it("accepts a BEC-like input and fills defaults", () => {
    const r = validateInput(becLike());
    expect(r).toEqual({
      ok: true,
      value: { ...becLike(), constructorArgs: "0x", timeoutSeconds: DEFAULT_TIMEOUT_SECONDS },
    });
    if (r.ok) {
      expect("legacyOptimizerRuns" in r.value).toBe(false);
      expect("fuzzSeed" in r.value).toBe(false);
    }
  });

  it("keeps optional values and runs when the optimizer is enabled", () => {
    const r = validateInput({
      ...becLike(),
      legacyOptimizer: true,
      legacyOptimizerRuns: 200,
      constructorArgs: "0x00ff",
      fuzzSeed: "0xdead",
      timeoutSeconds: 60,
    });
    expect(r.ok && r.value).toMatchObject({
      legacyOptimizer: true,
      legacyOptimizerRuns: 200,
      constructorArgs: "0x00ff",
      fuzzSeed: "0xdead",
      timeoutSeconds: 60,
    });
  });

  it("ignores and drops runs when the optimizer is disabled, even if invalid", () => {
    const r = validateInput({ ...becLike(), legacyOptimizerRuns: -5 });
    expect(r.ok).toBe(true);
    if (r.ok) expect("legacyOptimizerRuns" in r.value).toBe(false);
  });

  it("accepts runs at both bounds", () => {
    for (const runs of [0, 4294967295]) {
      expect(validateInput({ ...becLike(), legacyOptimizer: true, legacyOptimizerRuns: runs }).ok).toBe(true);
    }
  });

  it("does not mutate the input and returns a fresh object", () => {
    const raw = becLike();
    const snapshot = structuredClone(raw);
    const r = validateInput(raw);
    expect(raw).toEqual(snapshot);
    expect(r.ok && r.value).not.toBe(raw);
  });
});

describe("validateInput: missing", () => {
  const required = [
    "contractName",
    "legacySource",
    "portSource",
    "autopsyReport",
    "legacySolcVersion",
    "legacyOptimizer",
    "onChainRuntimeCode",
  ];
  it.each(required)("reports %s when missing, undefined or null", (f) => {
    for (const mutate of [
      (o: Record<string, unknown>) => delete o[f],
      (o: Record<string, unknown>) => (o[f] = undefined),
      (o: Record<string, unknown>) => (o[f] = null),
    ]) {
      const o = becLike();
      mutate(o);
      const e = fail(o);
      expect(e.code).toBe("MISSING_INPUT");
      expect(fieldsOf(e)).toEqual([f]);
      expect(e.message).toContain(f);
    }
  });

  it("requires runs only when the optimizer is enabled", () => {
    const e = invalidWith({ legacyOptimizer: true });
    expect(e.code).toBe("MISSING_INPUT");
    expect(fieldsOf(e)).toEqual(["legacyOptimizerRuns"]);
  });

  it("reports every missing field together in design order", () => {
    const e = fail({});
    expect(e.code).toBe("MISSING_INPUT");
    expect(fieldsOf(e)).toEqual([
      "contractName",
      "legacySource",
      "portSource",
      "autopsyReport",
      "legacySolcVersion",
      "legacyOptimizer",
      "onChainRuntimeCode",
    ]);
    for (const f of fieldsOf(e)) expect(e.message).toContain(f);
  });

  it("reports MISSING_INPUT before invalid fields", () => {
    const o = becLike();
    delete o.portSource;
    o.contractName = "";
    const e = fail(o);
    expect(e.code).toBe("MISSING_INPUT");
    expect(fieldsOf(e)).toEqual(["portSource"]);
  });

  it("rejects non-object input", () => {
    for (const raw of [undefined, null, 5, "x", [], [becLike()]]) {
      const e = fail(raw);
      expect(e.code).toBe("INVALID_INPUT");
      expect(fieldsOf(e)).toEqual(["input"]);
    }
  });
});

describe("validateInput: invalid", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["contractName", { contractName: "" }],
    ["contractName", { contractName: "A".repeat(129) }],
    ["contractName", { contractName: "1Token" }],
    ["contractName", { contractName: "Bec Token" }],
    ["contractName", { contractName: "../x" }],
    ["contractName", { contractName: 5 }],
    ["legacyOptimizer", { legacyOptimizer: "true" }],
    ["legacyOptimizer", { legacyOptimizer: 1 }],
    ["legacyOptimizerRuns", { legacyOptimizer: true, legacyOptimizerRuns: -1 }],
    ["legacyOptimizerRuns", { legacyOptimizer: true, legacyOptimizerRuns: 4294967296 }],
    ["legacyOptimizerRuns", { legacyOptimizer: true, legacyOptimizerRuns: 1.5 }],
    ["legacyOptimizerRuns", { legacyOptimizer: true, legacyOptimizerRuns: "200" }],
    ["legacyOptimizerRuns", { legacyOptimizer: true, legacyOptimizerRuns: Number.NaN }],
    ["legacySource", { legacySource: "" }],
    ["portSource", { portSource: "" }],
    ["legacySource", { legacySource: "a".repeat(MAX_SOURCE_BYTES + 1) }],
    ["portSource", { portSource: "a".repeat(MAX_SOURCE_BYTES + 1) }],
    ["legacySource", { legacySource: 7 }],
    ["autopsyReport", { autopsyReport: {} }],
    ["legacySolcVersion", { legacySolcVersion: "0.8.0" }],
    ["legacySolcVersion", { legacySolcVersion: "0.4" }],
    ["legacySolcVersion", { legacySolcVersion: "v0.4.19" }],
    ["legacySolcVersion", { legacySolcVersion: "^0.4.19" }],
    ["legacySolcVersion", { legacySolcVersion: "=0.4.19" }],
    ["legacySolcVersion", { legacySolcVersion: "0.4.19-nightly" }],
    ["legacySolcVersion", { legacySolcVersion: "0.04.19" }],
    ["legacySolcVersion", { legacySolcVersion: "0.4.019" }],
    ["onChainRuntimeCode", { onChainRuntimeCode: "0x" }],
    ["onChainRuntimeCode", { onChainRuntimeCode: "0x123" }],
    ["onChainRuntimeCode", { onChainRuntimeCode: "0xzz" }],
    ["onChainRuntimeCode", { onChainRuntimeCode: "6060" }],
    ["onChainRuntimeCode", { onChainRuntimeCode: "" }],
    ["constructorArgs", { constructorArgs: "00" }],
    ["fuzzSeed", { fuzzSeed: 42 }],
    ["fuzzSeed", { fuzzSeed: "-1" }],
    ["fuzzSeed", { fuzzSeed: "abc" }],
    ["fuzzSeed", { fuzzSeed: "" }],
    ["timeoutSeconds", { timeoutSeconds: 0 }],
    ["timeoutSeconds", { timeoutSeconds: -3 }],
    ["timeoutSeconds", { timeoutSeconds: 1.5 }],
    ["timeoutSeconds", { timeoutSeconds: "300" }],
  ];
  it.each(cases)("rejects bad %s: %j", (field, patch) => {
    const e = invalidWith(patch);
    expect(e.code).toBe("INVALID_INPUT");
    expect(fieldsOf(e)).toEqual([field]);
    expect(e.message).toContain(field);
    expect((e.details as { reasons: Record<string, string> }).reasons[field]).toBeTruthy();
  });

  it("accepts a source of exactly 1 MiB and rejects 1 MiB + 1 byte", () => {
    expect(validateInput({ ...becLike(), legacySource: "a".repeat(MAX_SOURCE_BYTES) }).ok).toBe(true);
    expect(invalidWith({ legacySource: "a".repeat(MAX_SOURCE_BYTES + 1) }).code).toBe("INVALID_INPUT");
  });

  it("counts source size in UTF-8 bytes, not characters", () => {
    // 'é' is 2 bytes: 524,288 chars = exactly 1 MiB; one more char exceeds it.
    expect(validateInput({ ...becLike(), legacySource: "é".repeat(MAX_SOURCE_BYTES / 2) }).ok).toBe(true);
    expect(fieldsOf(invalidWith({ legacySource: "é".repeat(MAX_SOURCE_BYTES / 2 + 1) }))).toEqual(["legacySource"]);
  });

  it("accepts 128-character names and the 0.7.6 / 0.0.0 solc bounds", () => {
    expect(validateInput({ ...becLike(), contractName: "A".repeat(128) }).ok).toBe(true);
    expect(validateInput({ ...becLike(), legacySolcVersion: "0.7.6" }).ok).toBe(true);
  });

  it("accepts an empty autopsy report (AUTOPSY_REJECTED handles it later)", () => {
    expect(validateInput({ ...becLike(), autopsyReport: "" }).ok).toBe(true);
  });

  it("reports every invalid field together, in design order", () => {
    const e = invalidWith({
      timeoutSeconds: 0,
      onChainRuntimeCode: "0x",
      legacySolcVersion: "0.8.0",
      contractName: "",
      legacyOptimizer: "yes",
    });
    expect(e.code).toBe("INVALID_INPUT");
    expect(fieldsOf(e)).toEqual([
      "contractName",
      "legacySolcVersion",
      "legacyOptimizer",
      "onChainRuntimeCode",
      "timeoutSeconds",
    ]);
    for (const f of fieldsOf(e)) expect(e.message).toContain(f);
  });

  it("is deterministic", () => {
    const patch = { contractName: "", legacySource: "", legacySolcVersion: "x" };
    expect(invalidWith(patch)).toEqual(invalidWith(patch));
  });
});

describe("validateInput: property", () => {
  const corruptions: Record<string, unknown> = {
    contractName: "",
    legacySource: "",
    portSource: "",
    legacySolcVersion: "0.8.0",
    legacyOptimizer: "nope",
    onChainRuntimeCode: "0x",
  };
  const names = Object.keys(corruptions);

  it("names exactly the corrupted fields", () => {
    fc.assert(
      fc.property(fc.subarray(names, { minLength: 1 }), fc.boolean(), (subset, asMissing) => {
        const o = becLike();
        for (const f of subset) {
          if (asMissing) delete o[f];
          else o[f] = corruptions[f];
        }
        const e = fail(o);
        const expected = INPUT_FIELD_ORDER.filter((f) => subset.includes(f));
        expect(e.code).toBe(asMissing ? "MISSING_INPUT" : "INVALID_INPUT");
        expect(fieldsOf(e)).toEqual(expected);
        for (const f of INPUT_FIELD_ORDER) {
          expect(e.message.includes(f)).toBe(subset.includes(f));
        }
      }),
      { numRuns: 100 },
    );
  });
});
