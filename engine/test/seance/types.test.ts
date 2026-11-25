import { describe, expect, it } from "vitest";
import {
  CLASSIFICATIONS,
  SEANCE_ERROR_CODES,
  UNSHRUNK_REASONS,
  err,
  handlerFaultError,
  isClassification,
  isPortBugFinding,
  isSeanceErrorCode,
  isUnshrunkFinding,
  isUnshrunkReason,
  ok,
  seanceError,
  timeoutError,
  type CallRecordWire,
  type Classification,
  type ClassificationCounts,
  type Finding,
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

// ---------------------------------------------------------------------------
// Finding union (compile-time checks run under `pnpm typecheck`)
// ---------------------------------------------------------------------------

const wire: CallRecordWire = { success: true, data: "0x", logs: [], stateHash: "0x00" };
const common = { function: "f", calldata: "0x", sender: "0x1", value: "0", precedingCalls: [] };

const shrunkExorcised: Finding = { ...common, classification: "exorcised", originalLength: 5 };
const unshrunkExorcised: Finding = {
  ...common,
  classification: "exorcised",
  unshrunk: true,
  unshrunkReason: "deadline",
};
const shrunkPortBug: Finding = {
  ...common,
  classification: "port-bug",
  originalLength: 3,
  legacy: wire,
  port: wire,
  differingFields: ["data"],
};
const unshrunkPortBug: Finding = {
  ...common,
  classification: "port-bug",
  unshrunk: true,
  unshrunkReason: "setup",
  legacy: wire,
  port: wire,
  differingFields: ["data"],
};

// (a) shrunk with unshrunkReason
// @ts-expect-error shrunk finding must not carry unshrunkReason
const badA: Finding = { ...common, classification: "exorcised", originalLength: 1, unshrunkReason: "setup" };
// (b) unshrunk without unshrunkReason
// @ts-expect-error unshrunk finding requires unshrunkReason
const badB: Finding = { ...common, classification: "exorcised", unshrunk: true };
// (c) unshrunk with originalLength
// @ts-expect-error unshrunk finding must not carry originalLength
const badC: Finding = { ...common, classification: "exorcised", unshrunk: true, unshrunkReason: "setup", originalLength: 2 };
// (d) port-bug without legacy/port/differingFields
// @ts-expect-error port-bug requires legacy, port and differingFields
const badD: Finding = { ...common, classification: "port-bug", originalLength: 1 };
// (e) exorcised with legacy
// @ts-expect-error exorcised must not carry legacy
const badE: Finding = { ...common, classification: "exorcised", originalLength: 1, legacy: wire };
void [badA, badB, badC, badD, badE];

describe("Finding guards", () => {
  it("narrow all four combinations", () => {
    for (const f of [shrunkExorcised, unshrunkExorcised, shrunkPortBug, unshrunkPortBug]) {
      if (isUnshrunkFinding(f)) {
        const reason: string = f.unshrunkReason;
        expect(reason).toBeTypeOf("string");
        // @ts-expect-error originalLength is `never` on unshrunk findings
        const n: number = f.originalLength;
        void n;
      } else {
        const n: number = f.originalLength;
        expect(n).toBeTypeOf("number");
      }
      if (isPortBugFinding(f)) {
        expect(f.legacy.success).toBe(true);
        expect(f.differingFields).toEqual(["data"]);
      } else {
        expect(f.classification).toBe("exorcised");
        expect(f.legacy).toBeUndefined();
      }
    }
    expect(isUnshrunkFinding(shrunkExorcised)).toBe(false);
    expect(isUnshrunkFinding(unshrunkPortBug)).toBe(true);
    expect(isPortBugFinding(shrunkPortBug)).toBe(true);
    expect(isPortBugFinding(unshrunkExorcised)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SeanceError union
// ---------------------------------------------------------------------------

const counts: ClassificationCounts = { match: 1, "reason-modernised": 0, exorcised: 0, "port-bug": 0 };

// @ts-expect-error TIMEOUT requires phase
const eA: SeanceError = { code: "TIMEOUT", message: "m" };
// @ts-expect-error TIMEOUT/build must not have partialCounts
const eB: SeanceError = { code: "TIMEOUT", message: "m", phase: "build", partialCounts: counts };
// @ts-expect-error BUILD_FAILED must not have partialCounts
const eC1: SeanceError = { code: "BUILD_FAILED", message: "m", partialCounts: counts };
// @ts-expect-error BUILD_FAILED must not have phase
const eC2: SeanceError = { code: "BUILD_FAILED", message: "m", phase: "build" };
const eD: SeanceError = { code: "HANDLER_FAULT", message: "m", partialCounts: counts };
const eE: SeanceError = { code: "TIMEOUT", message: "m", phase: "discovery", partialCounts: counts };
void [eA, eB, eC1, eC2];

describe("SeanceError builders", () => {
  it("accepts valid literals", () => {
    expect(eD.partialCounts).toEqual(counts);
    expect(eE.phase).toBe("discovery");
  });

  it("seanceError builds plain errors and omits absent details", () => {
    expect(seanceError("BUILD_FAILED", "x")).toEqual({ code: "BUILD_FAILED", message: "x" });
    expect(seanceError("BUILD_FAILED", "x", { a: 1 })).toEqual({ code: "BUILD_FAILED", message: "x", details: { a: 1 } });
    // @ts-expect-error TIMEOUT is not a plain code
    seanceError("TIMEOUT", "x");
  });

  it("timeoutError sets phase and only discovery takes partialCounts", () => {
    expect(timeoutError("build", "t")).toEqual({ code: "TIMEOUT", message: "t", phase: "build" });
    const d = timeoutError("discovery", "t", { partialCounts: counts });
    expect(d).toEqual({ code: "TIMEOUT", message: "t", phase: "discovery", partialCounts: counts });
    // @ts-expect-error build timeouts take no partialCounts
    timeoutError("build", "t", { partialCounts: counts });
    expect(Object.hasOwn(timeoutError("build", "t"), "partialCounts")).toBe(false);
  });

  it("handlerFaultError carries partialCounts", () => {
    expect(handlerFaultError("h", { partialCounts: counts })).toEqual({
      code: "HANDLER_FAULT",
      message: "h",
      partialCounts: counts,
    });
    expect(err(handlerFaultError("h")).ok).toBe(false);
  });
});
