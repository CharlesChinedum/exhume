import { describe, expect, it } from "vitest";
import {
  CLASSIFICATIONS,
  SEANCE_ERROR_CODES,
  UNSHRUNK_REASONS,
  err,
  isClassification,
  isSeanceErrorCode,
  isUnshrunkReason,
  ok,
  type Classification,
  type Result,
  type SeanceError,
} from "../../src/seance/types.js";

// Compile-time exhaustiveness: adding a Classification breaks this function.
function describeClass(c: Classification): string {
  switch (c) {
    case "match":
    case "reason-modernised":
    case "exorcised":
    case "port-bug":
      return c;
    default: {
      const _never: never = c;
      return _never;
    }
  }
}

describe("closed sets", () => {
  it("has exactly the 4 classifications", () => {
    expect([...CLASSIFICATIONS].sort()).toEqual(["exorcised", "match", "port-bug", "reason-modernised"]);
    expect(CLASSIFICATIONS.map(describeClass)).toEqual([...CLASSIFICATIONS]);
  });

  it("has exactly the 5 unshrunk reasons", () => {
    expect([...UNSHRUNK_REASONS].sort()).toEqual([
      "deadline",
      "replay-mismatch",
      "setup",
      "witness-cap",
      "witness-not-failed",
    ]);
  });

  it("has the 11 error codes from the design", () => {
    expect(SEANCE_ERROR_CODES).toHaveLength(11);
    expect(new Set(SEANCE_ERROR_CODES).size).toBe(11);
  });
});

describe("type guards", () => {
  it("accept members and reject others", () => {
    expect(isClassification("exorcised")).toBe(true);
    expect(isClassification("Exorcised")).toBe(false);
    expect(isClassification(undefined)).toBe(false);
    expect(isUnshrunkReason("setup")).toBe(true);
    expect(isUnshrunkReason("match")).toBe(false);
    expect(isSeanceErrorCode("TIMEOUT")).toBe(true);
    expect(isSeanceErrorCode("NOPE")).toBe(false);
  });
});

describe("Result helpers", () => {
  it("ok and err build the two variants", () => {
    const e: SeanceError = { code: "INVALID_INPUT", message: "bad" };
    const a: Result<number> = ok(1);
    const b: Result<number> = err(e);
    expect(a).toEqual({ ok: true, value: 1 });
    expect(b).toEqual({ ok: false, error: e });
  });
});
