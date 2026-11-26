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
  legacy: unknown;
  port: unknown;
  expect: { classification: string; invalidRecord: boolean; differingFields: string[] };
}

const all = vectors.vectors as Vector[];

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

  it("covers every classification and every decision-table row", () => {
    expect(new Set(all.map((v) => v.expect.classification))).toEqual(
      new Set(["match", "reason-modernised", "exorcised", "port-bug"]),
    );
    expect(new Set(all.map(row))).toEqual(
      new Set([
        "malformed",
        "revert/revert identical",
        "revert/revert differing",
        "success/revert Panic(0x11)",
        "success/revert other",
        "revert/success",
        "success/success equal",
        "success/success differing",
      ]),
    );
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
