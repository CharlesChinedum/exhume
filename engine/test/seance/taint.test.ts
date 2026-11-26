import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeTaint, verifyTaint } from "../../src/seance/taint.js";
import { CLASSIFICATIONS } from "../../src/seance/types.js";
import type { Classification, OrderedRecord } from "../../src/seance/types.js";

const wire = { success: true, data: "0x", logs: [], stateHash: "0x00" };
const cls = (...c: Classification[]) => c.map((classification) => ({ classification }));

/** Builds records from [idx, class, afterDivergence] triples, ordinals 1..n. */
function recs(rows: [number, Classification, boolean][]): OrderedRecord[] {
  return rows.map(([idx, classification, afterDivergence], i) => ({
    idx,
    function: "f",
    selector: "0x00000000",
    calldata: "0x00000000",
    sender: "0x" + "aa".repeat(20),
    value: "0",
    legacy: wire,
    port: wire,
    classification,
    differingFields: [],
    invalidRecord: false,
    afterDivergence,
    ordinal: i + 1,
  }));
}

describe("computeTaint", () => {
  it("is all false without a port-bug", () => {
    expect(computeTaint(cls("match", "reason-modernised", "exorcised", "match"), false)).toEqual([false, false, false, false]);
  });
  it("flags positions after a port-bug, not the port-bug itself", () => {
    expect(computeTaint(cls("match", "port-bug", "match", "exorcised", "port-bug"), false)).toEqual([false, false, true, true, true]);
  });
  it("reason-modernised before a port-bug does not taint", () => {
    expect(computeTaint(cls("reason-modernised", "port-bug", "match"), false)).toEqual([false, false, true]);
  });
  it("exorcised alone does not taint", () => {
    expect(computeTaint(cls("exorcised", "match"), false)).toEqual([false, false]);
  });
  it("setupDiverged taints every position", () => {
    expect(computeTaint(cls("match", "port-bug", "match"), true)).toEqual([true, true, true]);
  });
  it("handles empty input and does not mutate", () => {
    expect(computeTaint([], true)).toEqual([]);
    const input = cls("port-bug", "match");
    const copy = structuredClone(input);
    computeTaint(input, false);
    expect(input).toEqual(copy);
  });
});

describe("verifyTaint", () => {
  it("accepts empty and setup-only input", () => {
    expect(verifyTaint([]).ok).toBe(true);
    expect(verifyTaint(recs([[-1, "match", false], [-1, "match", false]])).ok).toBe(true);
  });
  it("accepts consistent data over several sequences", () => {
    const r = recs([
      [-1, "match", false],
      [0, "match", false],
      [1, "port-bug", false],
      [2, "match", true],
      [0, "match", false], // new sequence: not tainted by the previous one
      [1, "reason-modernised", false],
      [0, "exorcised", false],
    ]);
    expect(verifyTaint(r).ok).toBe(true);
  });
  it("a setup port-bug taints later setup records and every fuzz record", () => {
    const good = recs([
      [-1, "port-bug", false],
      [-1, "match", true],
      [0, "match", true],
      [0, "match", true],
    ]);
    expect(verifyTaint(good).ok).toBe(true);
    const bad = recs([
      [-1, "port-bug", false],
      [0, "match", false],
    ]);
    const res = verifyTaint(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("record 2 (idx 0)");
  });
  it("reports a mismatch in setup", () => {
    const res = verifyTaint(recs([[-1, "match", true], [0, "match", false]]));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("SEANCE_FAILED");
      expect(res.error.message).toContain("record 1 (idx -1)");
      expect(res.error.message).toContain("afterDivergence=true");
      expect(res.error.message).toContain("computed false");
    }
  });
  it("reports a mismatch in the middle of a sequence", () => {
    const res = verifyTaint(recs([[0, "port-bug", false], [1, "match", false], [2, "match", true]]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("record 2 (idx 1)");
  });
  it("reports a mismatch in a later sequence (no carry-over)", () => {
    const res = verifyTaint(recs([[0, "port-bug", false], [1, "match", true], [0, "match", true]]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("record 3 (idx 0)");
  });
  it("names only the first of two mismatches", () => {
    const res = verifyTaint(recs([[0, "match", true], [1, "match", true]]));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("record 1");
      expect(res.error.message).not.toContain("record 2");
    }
  });
  it("does not reorder records", () => {
    // idx 1 listed before idx 0: stream order rules, so idx 1 opens its own implicit sequence.
    const r = recs([[1, "port-bug", false], [0, "match", false]]);
    expect(verifyTaint(r).ok).toBe(true);
  });
  it("does not mutate input and works on plain RecordLine without ordinal", () => {
    const r = recs([[0, "match", true]]).map(({ ordinal: _o, ...line }) => line);
    const copy = structuredClone(r);
    const res = verifyTaint(r);
    expect(r).toEqual(copy);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("record 1");
  });
});

describe("computeTaint property", () => {
  it("is monotonic and never flags the first port-bug unless setupDiverged", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...CLASSIFICATIONS)), fc.boolean(), (cs, sd) => {
        const flags = computeTaint(cs.map((classification) => ({ classification })), sd);
        expect(flags).toHaveLength(cs.length);
        for (let i = 1; i < flags.length; i++) expect(flags[i]! || !flags[i - 1]!).toBe(true);
        const first = cs.indexOf("port-bug");
        if (first >= 0 && !sd) expect(flags[first]).toBe(false);
      }),
    );
  });
});
