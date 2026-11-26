/**
 * Task 13.3: checks the report that the Docker run (`accept-bec` in the linux/amd64 image) wrote to
 * graveyard/bec/seance-report.json. Skipped when the report is absent. The first-exorcism ordinal and the
 * sender-balance checks need the records, which the CLI's accept-bec already enforces (exit code 0).
 *
 * setupCalls formula (observed): 1 constructor record + (ACTOR_COUNT - 1) token share transfers + seed calls.
 * The task text says "actor count minus one plus seed calls"; that omits the constructor record.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ENGINE } from "./template-project.js";
import { BEC_FUNCTION } from "../../src/seance/acceptance.js";
import { parseReport, validateReport } from "../../src/seance/report.js";
import { CLASSIFICATIONS, isPortBugFinding, isUnshrunkFinding } from "../../src/seance/types.js";

const REPORT = resolve(ENGINE, "../graveyard/bec/seance-report.json");
const ACTOR_COUNT = 4; // [deployer, A1, A2, A3]
const CONSTRUCTOR_RECORDS = 1;

describe.skipIf(!existsSync(REPORT))("graveyard/bec/seance-report.json (Docker acceptance run)", () => {
  const parsed = existsSync(REPORT) ? parseReport(readFileSync(REPORT, "utf8")) : undefined;
  const report = () => {
    if (parsed === undefined || !parsed.ok) throw new Error(parsed?.ok === false ? parsed.error.message : "no report");
    return parsed.value;
  };

  it("parses and validates", () => {
    expect(parsed?.ok).toBe(true);
    expect(validateReport(report()).ok).toBe(true);
    expect(report().contract).toBe("BecToken");
  });

  it("counts sum to totalCalls, with zero port bugs", () => {
    const r = report();
    const sum = CLASSIFICATIONS.reduce((s, c) => s + r.counts[c], 0);
    expect(sum).toBe(r.totalCalls);
    expect(r.counts["port-bug"]).toBe(0);
    expect(r.portBugs).toEqual([]);
    expect(r.exorcisms.some(isPortBugFinding)).toBe(false);
  });

  it("has a shrunk batchTransfer exorcism and no unshrunk findings", () => {
    const r = report();
    const bt = r.exorcisms.filter((f) => f.function === BEC_FUNCTION);
    expect(bt.length).toBeGreaterThan(0);
    expect(r.exorcisms.some(isUnshrunkFinding)).toBe(false);
    expect(bt.some((f) => f.classification === "exorcised" && !isUnshrunkFinding(f))).toBe(true);
    expect(r.shrinking.pairsShrunk).toBeGreaterThan(0);
    expect(r.shrinking.pairsUnshrunk).toBe(0);
  });

  it("shrinking identity holds", () => {
    const s = report().shrinking;
    expect(s.pairsFound).toBe(s.pairsSetup + s.pairsShrunk + s.pairsUnshrunk + s.pairsOverCap);
  });

  it("setupCalls = constructor record + (actors - 1) share transfers + seed calls", () => {
    const r = report();
    const seedCalls = r.setupCalls - CONSTRUCTOR_RECORDS - (ACTOR_COUNT - 1);
    // BEC's autopsy has the constructor-balance precondition only, so no seed calls are expected.
    expect(seedCalls).toBe(0);
  });

  it("skips no function and has no unreachable site", () => {
    expect(report().skippedFunctions).toEqual([]);
    expect(report().unreachableSites).toEqual([]);
  });
});
