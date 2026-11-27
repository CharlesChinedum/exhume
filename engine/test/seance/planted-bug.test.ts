/**
 * Task 15.1: Planted_Port_Bug fixture and acceptance check (Requirement 10.1 to 10.6).
 * The real-forge run is native when forge, forge-std and solc 0.4.19 are available; otherwise it is skipped
 * (the Docker run is task 15.2).
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPlantedBugAcceptance, runPlantedBugAcceptance, type PlantedBugDeps } from "../../src/seance/acceptance.js";
import { listInstalledSolc } from "../../src/seance/bytecode.js";
import { parseRecords } from "../../src/seance/report.js";
import { createProcessRunner } from "../../src/seance/runner.js";
import type { CallRecordWire, Finding, SeanceReport, UnshrunkReason } from "../../src/seance/types.js";
import { UNSHRUNK_REASONS } from "../../src/seance/types.js";
import { ALLOWANCE_DECREMENT, plantAllowanceBug } from "./planted-bug.js";
import { ENGINE, LOCAL_STD, skipReason } from "./template-project.js";

const GRAVEYARD = resolve(ENGINE, "../graveyard");
const BEC = join(GRAVEYARD, "bec");
const GOLDEN = readFileSync(join(BEC, "port.golden.sol"), "utf8");
const A1 = "0x" + "00".repeat(19) + "a1";

// --- plantAllowanceBug ---------------------------------------------------------
describe("plantAllowanceBug", () => {
  it("removes exactly the allowance decrement and leaves every other byte alone", () => {
    const planted = plantAllowanceBug(GOLDEN);
    const lines = GOLDEN.split("\n");
    const i = lines.findIndex((l) => l.includes(ALLOWANCE_DECREMENT));
    expect(i).toBeGreaterThan(0);
    expect(planted).toBe([...lines.slice(0, i), ...lines.slice(i + 1)].join("\n"));
    expect(planted).not.toContain(ALLOWANCE_DECREMENT);
    expect(planted.length).toBe(GOLDEN.length - (lines[i]!.length + 1));
  });

  it("throws when the pattern is missing or appears twice", () => {
    expect(() => plantAllowanceBug("contract A {}")).toThrow(/found 0/);
    expect(() => plantAllowanceBug(GOLDEN + "\n    " + ALLOWANCE_DECREMENT + "\n")).toThrow(/found 2/);
    expect(() => plantAllowanceBug(plantAllowanceBug(GOLDEN))).toThrow(/found 0/);
  });

  it("does not modify the golden file", () => {
    const before = readFileSync(join(BEC, "port.golden.sol"));
    plantAllowanceBug(GOLDEN);
    expect(readFileSync(join(BEC, "port.golden.sol")).equals(before)).toBe(true);
  });
});

const solcs = listInstalledSolc();
const compileSkip = spawnSync("forge", ["--version"]).status !== 0 ? "forge is not on PATH" : !solcs.includes("0.8.28") ? "solc 0.8.28 is not installed" : "";
describe.skipIf(compileSkip !== "")(`planted source compiles (skipped: ${compileSkip})`, () => {
  it("compiles under solc 0.8.28", () => {
    const dir = mkdtempSync(join(tmpdir(), "exhume-planted-compile-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/Port.sol"), plantAllowanceBug(GOLDEN));
    writeFileSync(join(dir, "foundry.toml"), `[profile.default]\nsolc = "0.8.28"\nsrc = "src"\nout = "out"\ncache_path = "cache"\noffline = true\n`);
    const r = spawnSync("forge", ["build", "--root", dir], { encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }, 120_000);
});

// --- checkPlantedBugAcceptance --------------------------------------------------
const wire = (success: boolean, data = "0x01"): CallRecordWire => ({ success, data, logs: [], stateHash: "0x" + "00".repeat(32) });
const tfCalldata = "0x23b872dd" + "00".repeat(96);

function finding(over: Record<string, unknown> = {}): Finding {
  return {
    function: "transferFrom",
    classification: "port-bug",
    calldata: tfCalldata,
    sender: A1,
    value: "0",
    precedingCalls: [{ function: "approve", calldata: "0x095ea7b3", sender: A1, value: "0" }],
    originalLength: 9,
    site: "unattributed",
    legacy: wire(true),
    port: wire(true),
    differingFields: ["state.allowance(1,2)"],
    ...over,
  } as Finding;
}
function unshrunkF(reason: UnshrunkReason, over: Record<string, unknown> = {}): Finding {
  const { originalLength: _o, ...f } = finding(over) as Finding & { originalLength?: number };
  return { ...f, unshrunk: true, unshrunkReason: reason } as Finding;
}
function report(over: Partial<SeanceReport> = {}, bugs: Finding[] = [finding()]): SeanceReport {
  const unshrunk = bugs.filter((f) => f.unshrunk === true).length;
  return {
    schemaVersion: "1",
    contract: "BecToken",
    seed: "1",
    runs: 256,
    depth: 64,
    totalCalls: 100,
    counts: { match: 94, "reason-modernised": 4, exorcised: 1, "port-bug": 1 },
    taintedCalls: 0,
    setupCalls: 4,
    firstExorcismFuzzOrdinal: null,
    exorcisms: [],
    portBugs: bugs,
    sequenceResults: { total: 3, endedExorcised: 0, exorcisedAtIndex: [] },
    shrinking: {
      witnessCap: 10,
      pairsFound: bugs.length,
      pairsSetup: 0,
      pairsShrunk: bugs.length - unshrunk,
      pairsUnshrunk: unshrunk,
      pairsOverCap: 0,
      deadlineReached: false,
    },
    unreachableSites: [],
    skippedFunctions: [],
    ...over,
  };
}
const failedOf = (r: ReturnType<typeof checkPlantedBugAcceptance>) => {
  if (r.ok) throw new Error("expected ACCEPTANCE_FAILED");
  expect(r.error.code).toBe("ACCEPTANCE_FAILED");
  return (r.error.details as { failed: { condition: string; observed: unknown }[] }).failed;
};
const names = (r: ReturnType<typeof checkPlantedBugAcceptance>): string[] => failedOf(r).map((f) => f.condition);

describe("checkPlantedBugAcceptance (pure)", () => {
  it("passes on a shrunk transferFrom port-bug with the allowance field and one preceding call", () => {
    const r = checkPlantedBugAcceptance(report());
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.precedingCalls).toBe(1);
    expect(r.value.differingFields).toEqual(["state.allowance(1,2)"]);
  });

  it("passes with exactly 3 preceding calls", () => {
    const pre = Array.from({ length: 3 }, () => ({ function: "approve", calldata: "0x", sender: A1, value: "0" }));
    expect(checkPlantedBugAcceptance(report({}, [finding({ precedingCalls: pre })])).ok).toBe(true);
  });

  it("fails with planted-bug-not-detected when no port bug is reported (10.6)", () => {
    const r = checkPlantedBugAcceptance(report({ totalCalls: 100, counts: { match: 95, "reason-modernised": 4, exorcised: 1, "port-bug": 0 } }, []));
    expect(names(r)).toEqual(["planted-bug-not-detected"]);
    expect(failedOf(r)[0]!.observed).toEqual({ counts: 0, findings: 0 });
  });

  it("fails when the port bug is in another function only", () => {
    expect(names(checkPlantedBugAcceptance(report({}, [finding({ function: "transfer" })])))).toEqual(["port-bug-not-in-transferFrom"]);
  });

  it("fails when differingFields has no allowance key (success/returnData/other state only)", () => {
    for (const fields of [["success"], ["returnData", "success"], ["state.balanceOf(1)"], ["state.totalSupply"]]) {
      expect(names(checkPlantedBugAcceptance(report({}, [finding({ differingFields: fields })])))).toEqual(["allowance-field-not-differing"]);
    }
  });

  it("fails when the allowance differs but the call returned different results (10.5)", () => {
    expect(names(checkPlantedBugAcceptance(report({}, [finding({ legacy: wire(true), port: wire(false) })])))).toEqual(["allowance-field-not-differing"]);
  });

  it.each([...UNSHRUNK_REASONS])("fails an unshrunk finding naming unshrunkReason %s", (reason) => {
    const r = checkPlantedBugAcceptance(report({}, [unshrunkF(reason)]));
    expect(names(r)).toEqual(["unshrunk"]);
    expect(failedOf(r)[0]!.observed).toMatchObject({ unshrunkReason: reason });
    if (!r.ok) expect(r.error.message).toContain(`unshrunkReason: ${reason}`);
  });

  it("fails with 4 preceding calls", () => {
    const four = Array.from({ length: 4 }, () => ({ function: "approve", calldata: "0x", sender: A1, value: "0" }));
    const r = checkPlantedBugAcceptance(report({ counts: { match: 94, "reason-modernised": 4, exorcised: 1, "port-bug": 1 } }, [finding({ precedingCalls: four })]));
    expect(names(r)).toEqual(["preceding-calls-exceed-3"]);
  });

  it("fails when counts and findings disagree, and when counts do not sum", () => {
    expect(names(checkPlantedBugAcceptance(report({ counts: { match: 95, "reason-modernised": 4, exorcised: 1, "port-bug": 0 } })))).toEqual(["port-bug-counts-mismatch"]);
    expect(names(checkPlantedBugAcceptance(report({ totalCalls: 101 })))).toContain("counts-sum");
  });
});

// --- runPlantedBugAcceptance (stubbed séance) ------------------------------------
function tempGraveyard(): string {
  const root = mkdtempSync(join(tmpdir(), "exhume-planted-grave-"));
  cpSync(BEC, join(root, "bec"), { recursive: true, filter: (src) => !src.endsWith("seance-report.json") });
  return root;
}
function stubDeps(root: string, rep: SeanceReport, seen: { portSource?: string }, outputRoot?: string): PlantedBugDeps {
  return {
    graveyardRoot: root,
    ...(outputRoot !== undefined && { outputRoot }),
    runner: createProcessRunner(),
    now: Date.now,
    tmpRoot: tmpdir(),
    seance: async (input) => {
      seen.portSource = (input as { portSource: string }).portSource;
      return { ok: true, value: { report: rep } };
    },
  };
}
const realReportPath = join(BEC, "seance-report.json");
const bytesOrNull = (p: string): Buffer | null => (existsSync(p) ? readFileSync(p) : null);

describe("runPlantedBugAcceptance with a stubbed séance", () => {
  it("runs the séance on the planted port and writes only <outputRoot>/bec-planted", async () => {
    const root = tempGraveyard();
    const out = mkdtempSync(join(tmpdir(), "exhume-planted-out-"));
    const before = bytesOrNull(realReportPath);
    const seen: { portSource?: string } = {};
    const r = await runPlantedBugAcceptance(stubDeps(root, report(), seen, out), { plant: plantAllowanceBug });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(seen.portSource).toBe(plantAllowanceBug(GOLDEN));
    expect(r.value.reportPath).toBe(join(out, "bec-planted", "seance-report.json"));
    expect(existsSync(join(root, "bec", "seance-report.json"))).toBe(false);
    expect(bytesOrNull(realReportPath)).toEqual(before);
  });

  it("writes nothing without an outputRoot", async () => {
    const root = tempGraveyard();
    const r = await runPlantedBugAcceptance(stubDeps(root, report(), {}), { plant: plantAllowanceBug });
    expect(r.ok && r.value.reportPath === undefined).toBe(true);
    expect(existsSync(join(root, "bec", "seance-report.json"))).toBe(false);
  });

  it("returns ACCEPTANCE_FAILED planted-bug-not-detected on zero port bugs and writes no report", async () => {
    const root = tempGraveyard();
    const out = mkdtempSync(join(tmpdir(), "exhume-planted-out-"));
    const before = bytesOrNull(realReportPath);
    const none = report({ counts: { match: 95, "reason-modernised": 4, exorcised: 1, "port-bug": 0 } }, []);
    const r = await runPlantedBugAcceptance(stubDeps(root, none, {}, out), { plant: plantAllowanceBug });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("ACCEPTANCE_FAILED");
    expect((r.error.details as { failed: { condition: string }[] }).failed.map((f) => f.condition)).toEqual(["planted-bug-not-detected"]);
    expect(existsSync(join(out, "bec-planted"))).toBe(false);
    expect(bytesOrNull(realReportPath)).toEqual(before);
  });

  it("returns INVALID_INPUT when the plant function throws, and a runSeance error unchanged", async () => {
    const root = tempGraveyard();
    const bad = await runPlantedBugAcceptance(stubDeps(root, report(), {}), { plant: () => { throw new Error("no pattern"); } });
    expect(bad.ok === false && bad.error.code).toBe("INVALID_INPUT");
    const error = { code: "TIMEOUT" as const, phase: "discovery" as const, message: "deadline" };
    const r = await runPlantedBugAcceptance({ ...stubDeps(root, report(), {}), seance: async () => ({ ok: false as const, error }) }, { plant: plantAllowanceBug });
    expect(r).toEqual({ ok: false, error });
  });
});

// --- real forge ------------------------------------------------------------------
const skip = skipReason !== "" ? skipReason : !solcs.includes("0.4.19") ? "solc 0.4.19 is not installed" : "";

describe.skipIf(skip !== "")(`Planted_Port_Bug with native forge${skip ? ` (skipped: ${skip})` : ""}`, () => {
  it(
    "detects the missing allowance decrement as a shrunk transferFrom port-bug",
    async () => {
      const root = tempGraveyard();
      const before = bytesOrNull(realReportPath);
      const t0 = Date.now();
      const r = await runPlantedBugAcceptance(
        {
          graveyardRoot: root,
          outputRoot: root,
          runner: createProcessRunner(),
          now: Date.now,
          tmpRoot: root,
          forgeStdDir: LOCAL_STD,
          keepTempOnSuccess: true,
        },
        { plant: plantAllowanceBug },
      );
      const ms = Date.now() - t0;
      if (!r.ok) {
        // eslint-disable-next-line no-console
        console.log(`[15.1 planted] FAILED after ${ms} ms:\n${JSON.stringify(r.error, null, 2)}`);
        throw new Error(`${r.error.code}: ${r.error.message}`);
      }
      const rep = r.value.report;
      const parsed = parseRecords(readFileSync(join(r.value.tempDir!, "seance-out/records.jsonl"), "utf8"), rep.runs);
      if (!parsed.ok) throw new Error(parsed.error.message);
      const tf = parsed.value.records.filter((x) => x.function === "transferFrom" && x.classification === "port-bug");
      // eslint-disable-next-line no-console
      console.log(`[15.1 planted] first transferFrom port-bug at fuzzOrdinal ${tf[0]?.fuzzOrdinal}; transferFrom port-bug records: ${tf.length}`);
      expect(tf.length).toBeGreaterThan(0);
      // eslint-disable-next-line no-console
      console.log(
        `[15.1 planted] passed in ${ms} ms\n` +
          JSON.stringify({ totalCalls: rep.totalCalls, counts: rep.counts, finding: { ...r.value.summary.finding, calldata: undefined } }, null, 2),
      );
      expect(r.value.summary.precedingCalls).toBeLessThanOrEqual(3);
      expect(bytesOrNull(realReportPath)).toEqual(before);
    },
    240_000,
  );
});
