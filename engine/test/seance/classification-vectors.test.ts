/**
 * Runs the shared classification vectors against `classify`.
 *
 * The same file (engine/test/vectors/classification.json) is consumed by the
 * generated Classifier.sol forge test through vm.parseJson / stdJson. JSON has
 * no comments, so each vector explains itself in `description`. Wire-format
 * constraint for Solidity: `state` is an object (name -> hex value), matching the
 * TS CallRecord; Solidity enumerates it with vm.parseJsonKeys. See `notes` in the file.
 */
import { describe, expect, it } from "vitest";
import vectors from "../vectors/classification.json" with { type: "json" };
import { classify } from "../../src/seance/classify.js";

interface Vector {
  name: string;
  description: string;
  scope: "ts-only" | "both";
  legacy: unknown;
  port: unknown;
  expect: { classification: string; invalidRecord: boolean; differingFields: string[] };
}

const all = vectors.vectors as Vector[];

/**
 * Selects the vectors a Solidity parity test must run: every vector whose scope
 * is "both" (an absent scope also means "both"). ts-only vectors are malformed
 * records that cannot be expressed as typed EVM values, so forge skips them.
 */
export const parityVectors = (vs: readonly Vector[]): Vector[] => vs.filter((v) => (v.scope ?? "both") === "both");

const success = (r: unknown): boolean => (r as { success: boolean }).success;
const data = (r: unknown): string => (r as { data: string }).data.toLowerCase();

/** Decision-table row of a vector, derived from the vector's inputs and expected outcome. */
function row(v: Vector): string {
  if (v.expect.invalidRecord) return "malformed";
  const l = success(v.legacy);
  const p = success(v.port);
  if (!l && !p) return data(v.legacy) === data(v.port) ? "revert/revert identical" : "revert/revert differing";
  if (l && !p) return v.expect.classification === "exorcised" ? "success/revert Panic(0x11)" : "success/revert other";
  if (!l && p) return "revert/success";
  return v.expect.classification === "match" ? "success/success equal" : "success/success differing";
}

describe("classification vectors", () => {
  it("has version 1 and a non-empty vector list", () => {
    expect(vectors.version).toBe(1);
    expect(all.length).toBeGreaterThan(0);
  });

  it("has unique vector names", () => {
    const names = all.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });

  const ROWS = [
    "malformed",
    "revert/revert identical",
    "revert/revert differing",
    "success/revert Panic(0x11)",
    "success/revert other",
    "revert/success",
    "success/success equal",
    "success/success differing",
  ];

  it("covers every classification and every decision-table row", () => {
    expect(new Set(all.map((v) => v.expect.classification))).toEqual(
      new Set(["match", "reason-modernised", "exorcised", "port-bug"]),
    );
    expect(new Set(all.map(row))).toEqual(new Set(ROWS));
  });

  it("covers every decision-table row except malformed among both-scope vectors", () => {
    expect(new Set(parityVectors(all).map(row))).toEqual(new Set(ROWS.filter((r) => r !== "malformed")));
  });

  it("gives every vector an explicit scope of ts-only or both", () => {
    for (const v of all) expect(["ts-only", "both"], v.name).toContain(v.scope);
  });

  it("is ts-only exactly when the record is malformed", () => {
    for (const v of all) {
      expect(v.scope === "ts-only", v.name).toBe(v.expect.invalidRecord === true);
    }
    const tsOnly = all.filter((v) => v.scope === "ts-only").length;
    const invalid = all.filter((v) => v.expect.invalidRecord === true).length;
    expect(tsOnly).toBe(invalid);
    expect(parityVectors(all).length).toBe(all.length - invalid);
    console.log(`scopes: ts-only=${tsOnly}, both=${all.length - tsOnly}`);
  });

  it("keeps null records in ts-only vectors", () => {
    for (const v of all) {
      if (v.legacy === null || v.port === null) expect(v.scope, v.name).toBe("ts-only");
    }
  });

  it("lists expected differingFields sorted, unique, and empty unless a valid port-bug", () => {
    for (const v of all) {
      const f = v.expect.differingFields;
      expect(f, v.name).toEqual([...new Set(f)].sort());
      if (v.expect.invalidRecord || v.expect.classification !== "port-bug") expect(f, v.name).toEqual([]);
      if (v.expect.invalidRecord) expect(v.expect.classification, v.name).toBe("port-bug");
    }
  });

  it.each(all.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    expect(classify(v.legacy, v.port)).toEqual(v.expect);
  });
});
