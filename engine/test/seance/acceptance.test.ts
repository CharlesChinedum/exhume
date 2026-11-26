/**
 * Task 13.2: BEC acceptance (Requirement 9).
 *
 * Pure checks run on hand-built reports. `runBecAcceptance` is exercised with a stubbed `runSeance`
 * (the `seance` dependency) for the write and no-overwrite behaviour, and with the real native forge
 * run into a TEMP graveyard root (the repo's graveyard/bec is not touched; task 13.3 stores the real report).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BEC_FUZZ_BUDGET,
  checkBecAcceptance,
  decodeBatchTransfer,
  deriveSenderLegacyBalance,
  firstExorcismFuzzOrdinal,
  runBecAcceptance,
  type BecAcceptanceDeps,
} from "../../src/seance/acceptance.js";
import { listInstalledSolc } from "../../src/seance/bytecode.js";
import { selectorOf } from "../../src/seance/keccak.js";
import { parseRecords, parseReport, serializeReport } from "../../src/seance/report.js";
import { createProcessRunner } from "../../src/seance/runner.js";
import type { Finding, RecordLine, SeanceReport, UnshrunkReason } from "../../src/seance/types.js";
import { UNSHRUNK_REASONS } from "../../src/seance/types.js";
import { ENGINE, LOCAL_STD, skipReason } from "./template-project.js";

const TWO = 1n << 256n;
const A1 = "0x" + "00".repeat(19) + "a1";
const A2 = "0x" + "00".repeat(19) + "a2";
const A3 = "0x" + "00".repeat(19) + "a3";
const D0 = "0x" + "00".repeat(19) + "d0";
const SHARE = (7_000_000_000n * 10n ** 18n) / 4n;
const BALANCE = 10n ** 27n;

const w = (n: bigint): string => n.toString(16).padStart(64, "0");
const addrWord = (a: string): string => a.slice(2).padStart(64, "0");
function batchCalldata(n: number, value: bigint): string {
  const recv = Array.from({ length: n }, (_, i) => addrWord(`0x${(0xb0 + i).toString(16)}`)).join("");
  return `${selectorOf("batchTransfer(address[],uint256)")}${w(64n)}${w(value)}${w(BigInt(n))}${recv}`;
}
const transferCalldata = (to: string, v: bigint): string => `${selectorOf("transfer(address,uint256)")}${addrWord(to)}${w(v)}`;
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

function shrunk(over: Partial<Finding> = {}): Finding {
  return {
    function: "batchTransfer",
    classification: "exorcised",
    calldata: batchCalldata(5, TWO / 5n + 3n),
    sender: A1,
    value: "0",
    precedingCalls: [],
    originalLength: 17,
    site: "unattributed",
    ...over,
  } as Finding;
}
function unshrunkFinding(reason: UnshrunkReason): Finding {
  return {
    function: "batchTransfer",
    classification: "exorcised",
    calldata: batchCalldata(5, TWO / 5n + 3n),
    sender: A1,
    value: "0",
    precedingCalls: [],
    unshrunk: true,
    unshrunkReason: reason,
    site: "unattributed",
  } as Finding;
}
function report(over: Partial<SeanceReport> = {}, finding: Finding | null = shrunk()): SeanceReport {
  const unshrunkN = finding && finding.unshrunk === true ? 1 : 0;
  return {
    schemaVersion: "1",
    contract: "BecToken",
    seed: "1",
    runs: 256,
    depth: 64,
    totalCalls: 100,
    counts: { match: 94, "reason-modernised": 5, exorcised: 1, "port-bug": 0 },
    taintedCalls: 0,
    setupCalls: 4,
    exorcisms: finding ? [finding] : [],
    portBugs: [],
    sequenceResults: { total: 3, endedExorcised: 1, exorcisedAtIndex: [4] },
    shrinking: {
      witnessCap: 10,
      pairsFound: finding ? 1 : 0,
      pairsSetup: 0,
      pairsShrunk: finding ? 1 - unshrunkN : 0,
      pairsUnshrunk: unshrunkN,
      pairsOverCap: 0,
      deadlineReached: false,
    },
    unreachableSites: [],
    skippedFunctions: [],
    ...over,
  };
}
const good = { firstExorcismFuzzOrdinal: 120, legacyBalanceOf: () => BALANCE };
const failedOf = (r: ReturnType<typeof checkBecAcceptance>) => {
  if (r.ok) throw new Error("expected ACCEPTANCE_FAILED");
  expect(r.error.code).toBe("ACCEPTANCE_FAILED");
  return (r.error.details as { failed: { condition: string; observed: unknown; expected: unknown }[] }).failed;
};

describe("checkBecAcceptance (pure)", () => {
  it("accepts a (5 receivers, ~2^256/5) witness: the old (2, >= 2^255) shape is not required", () => {
    const r = checkBecAcceptance(report(), good);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      firstExorcismFuzzOrdinal: 120,
      receivers: 5,
      value: (TWO / 5n + 3n).toString(),
      wrappedProduct: "14",
      senderLegacyBalance: BALANCE.toString(),
    });
    expect(r.value.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("fails with missing-exorcism when there is no exorcism, and when it is in another function", () => {
    const none = failedOf(checkBecAcceptance(report({}, null), good));
    expect(none).toEqual([
      {
        condition: "missing-exorcism",
        observed: { exorcisedFunctions: [], exorcisedCalls: 1 },
        expected: "an exorcised finding in batchTransfer",
      },
    ]);
    const other = failedOf(checkBecAcceptance(report({}, shrunk({ function: "transfer" })), good));
    expect(other).toEqual([
      {
        condition: "missing-exorcism",
        observed: { exorcisedFunctions: ["transfer"], exorcisedCalls: 1 },
        expected: "an exorcised finding in batchTransfer",
      },
    ]);
  });

  it("fails on a port-bug count of 1", () => {
    const f = failedOf(checkBecAcceptance(report({ counts: { match: 94, "reason-modernised": 4, exorcised: 1, "port-bug": 1 } }), good));
    expect(f).toEqual([
      { condition: "port-bug-count", observed: { counts: 1, findings: 0, portBugFindings: 0 }, expected: { counts: 0, findings: 0 } },
    ]);
  });

  it("budget: fuzzOrdinal 2000 passes, 2001 fails, unknown fails", () => {
    expect(checkBecAcceptance(report(), { ...good, firstExorcismFuzzOrdinal: BEC_FUZZ_BUDGET }).ok).toBe(true);
    expect(failedOf(checkBecAcceptance(report(), { ...good, firstExorcismFuzzOrdinal: 2001 }))).toEqual([
      { condition: "call-budget-exceeded", observed: 2001, expected: "fuzzOrdinal of the first batchTransfer exorcism at most 2000" },
    ]);
    expect(failedOf(checkBecAcceptance(report(), { ...good, firstExorcismFuzzOrdinal: null }))[0]).toMatchObject({
      condition: "call-budget-exceeded",
      observed: null,
    });
  });

  it.each(UNSHRUNK_REASONS)("fails an unshrunk finding naming unshrunkReason %s", (reason) => {
    const r = checkBecAcceptance(report({}, unshrunkFinding(reason)), good);
    expect(failedOf(r)).toEqual([
      { condition: "unshrunk", observed: { unshrunkReason: reason }, expected: "shrunk and replay-confirmed" },
    ]);
    if (!r.ok) expect(r.error.message).toContain(`unshrunkReason: ${reason}`);
  });

  it("receivers: 2 and 20 accepted; 21 rejected; 1 rejected (and cannot reach 2^256)", () => {
    expect(checkBecAcceptance(report({}, shrunk({ calldata: batchCalldata(2, 1n << 255n) })), good).ok).toBe(true);
    expect(checkBecAcceptance(report({}, shrunk({ calldata: batchCalldata(20, ceilDiv(TWO, 20n)) })), good).ok).toBe(true);
    const v21 = ceilDiv(TWO, 21n);
    expect(failedOf(checkBecAcceptance(report({}, shrunk({ calldata: batchCalldata(21, v21) })), good))).toEqual([
      { condition: "receivers-length", observed: 21, expected: "2..20 inclusive" },
    ]);
    const one = failedOf(checkBecAcceptance(report({}, shrunk({ calldata: batchCalldata(1, TWO - 1n) })), { ...good, legacyBalanceOf: () => TWO }));
    expect(one.map((x) => x.condition)).toEqual(["receivers-length", "product-below-2^256"]);
  });

  it("fails when receivers * value < 2^256", () => {
    const v = TWO / 5n - 1n;
    const f = failedOf(checkBecAcceptance(report({}, shrunk({ calldata: batchCalldata(5, v) })), { ...good, legacyBalanceOf: () => TWO }));
    expect(f).toEqual([
      {
        condition: "product-below-2^256",
        observed: { receivers: 5, value: v.toString(), product: (5n * v).toString() },
        expected: "receivers * value >= 2^256",
      },
    ]);
  });

  it("fails when the wrapped product exceeds the sender's legacy balance, and when no balance is available", () => {
    const v = TWO / 5n + 10n ** 30n;
    const wrapped = (5n * v) % TWO;
    expect(wrapped > BALANCE).toBe(true);
    expect(failedOf(checkBecAcceptance(report({}, shrunk({ calldata: batchCalldata(5, v) })), good))).toEqual([
      {
        condition: "wrapped-product-above-balance",
        observed: { wrappedProduct: wrapped.toString(), senderLegacyBalance: BALANCE.toString(), balanceApproximate: false },
        expected: "wrapped product <= sender's legacy balance",
      },
    ]);
    // Boundary: balance equal to the wrapped product passes.
    expect(checkBecAcceptance(report({}, shrunk({ calldata: batchCalldata(5, v) })), { ...good, legacyBalanceOf: () => wrapped }).ok).toBe(true);
    expect(failedOf(checkBecAcceptance(report(), { firstExorcismFuzzOrdinal: 1 }))[0]).toMatchObject({
      condition: "wrapped-product-above-balance",
      observed: { senderLegacyBalance: "unavailable" },
    });
  });

  it("fails an undecodable calldata and counts that do not sum", () => {
    expect(failedOf(checkBecAcceptance(report({}, shrunk({ calldata: "0x1234" })), good))[0]).toMatchObject({ condition: "calldata-undecodable" });
    const f = failedOf(checkBecAcceptance(report({ totalCalls: 101 }), good));
    expect(f[0]).toEqual({ condition: "counts-sum", observed: { sum: 100, totalCalls: 101 }, expected: "counts sum to totalCalls" });
    expect(f.map((x) => x.condition)).toEqual(["counts-sum", "report-invalid"]);
  });

  it("reports several failures together", () => {
    const f = failedOf(
      checkBecAcceptance(report({ counts: { match: 94, "reason-modernised": 4, exorcised: 1, "port-bug": 1 } }, unshrunkFinding("deadline")), {
        firstExorcismFuzzOrdinal: 5000,
        legacyBalanceOf: () => BALANCE,
      }),
    );
    expect(f.map((x) => x.condition)).toEqual(["port-bug-count", "call-budget-exceeded", "unshrunk"]);
  });
});

describe("decodeBatchTransfer", () => {
  it("decodes a canonical call and rejects a wrong selector, truncation and a bad offset", () => {
    const cd = batchCalldata(3, 7n);
    expect(decodeBatchTransfer(cd)).toMatchObject({ value: 7n });
    expect(decodeBatchTransfer(cd)!.receivers).toHaveLength(3);
    expect(decodeBatchTransfer(cd.replace(selectorOf("batchTransfer(address[],uint256)").slice(2), "deadbeef"))).toBeUndefined();
    expect(decodeBatchTransfer(cd.slice(0, -64))).toBeUndefined();
    expect(decodeBatchTransfer(cd.replace(w(64n), w(32n)))).toBeUndefined();
  });
});

// --- records fixtures --------------------------------------------------------
const wire = (success = true) => ({ success, data: "0x", logs: [], stateHash: "0x00" });
function rec(idx: number, fn: string, calldata: string, sender: string, classification: RecordLine["classification"] = "match"): RecordLine {
  return {
    idx,
    function: fn,
    selector: calldata.slice(0, 10),
    calldata,
    sender,
    value: "0",
    legacy: wire(true),
    port: classification === "exorcised" ? wire(false) : wire(true),
    classification,
    differingFields: [],
    invalidRecord: false,
    afterDivergence: false,
  };
}
const setupLines = (): RecordLine[] => [
  rec(-1, "constructor", "0x", D0),
  rec(-1, "transfer", transferCalldata(A1, SHARE), D0),
  rec(-1, "transfer", transferCalldata(A2, SHARE), D0),
  rec(-1, "transfer", transferCalldata(A3, SHARE), D0),
];
const jsonl = (ls: RecordLine[]): string => ls.map((l) => JSON.stringify(l)).join("\n") + "\n";

describe("records-derived inputs", () => {
  const stream = [
    ...setupLines(),
    rec(0, "transfer", transferCalldata(A2, 1n), A1),
    rec(1, "batchTransfer", batchCalldata(5, TWO / 5n + 3n), A1, "exorcised"),
    rec(0, "batchTransfer", batchCalldata(5, TWO / 5n + 3n), A2, "exorcised"),
  ];
  const parsed = parseRecords(jsonl(stream), 256);
  if (!parsed.ok) throw new Error(parsed.error.message);

  it("firstExorcismFuzzOrdinal counts fuzz records only (setup excluded) and is null without an exorcism", () => {
    expect(firstExorcismFuzzOrdinal(parsed.value)).toBe(2);
    const none = parseRecords(jsonl(stream.slice(0, 5)), 256);
    if (!none.ok) throw new Error("parse");
    expect(firstExorcismFuzzOrdinal(none.value)).toBeNull();
  });

  it("derives the sender balance from the setup shares and modelled preceding calls (exact)", () => {
    const f = shrunk({ sender: A1, precedingCalls: [{ function: "transfer", calldata: transferCalldata(A2, 1000n), sender: A1, value: "0" }] });
    expect(deriveSenderLegacyBalance(parsed.value.setupRecords, f)).toMatchObject({ balance: SHARE - 1000n, approximate: false });
    expect(deriveSenderLegacyBalance(parsed.value.setupRecords, shrunk({ sender: D0 })).balance).toBe(7_000_000_000n * 10n ** 18n - 3n * SHARE);
  });

  it("marks the balance approximate after an unmodelled preceding call", () => {
    const f = shrunk({ precedingCalls: [{ function: "transferFrom", calldata: "0x", sender: A1, value: "0" }] });
    const d = deriveSenderLegacyBalance(parsed.value.setupRecords, f);
    expect(d.approximate).toBe(true);
    expect(d.note).toContain("APPROXIMATE");
  });
});

// --- runBecAcceptance --------------------------------------------------------
const BEC = resolve(ENGINE, "../graveyard/bec");

function tempGraveyard(): string {
  const root = mkdtempSync(join(tmpdir(), "exhume-accept-grave-"));
  // A real seance-report.json (the Docker acceptance run, task 13.3) must not leak into the temp copy.
  cpSync(BEC, join(root, "bec"), { recursive: true, filter: (src) => !src.endsWith("seance-report.json") });
  return root;
}

function stubDeps(root: string, rep: SeanceReport, lines: RecordLine[]): BecAcceptanceDeps & { tempDirs: string[] } {
  const tempDirs: string[] = [];
  return {
    graveyardRoot: root,
    runner: createProcessRunner(),
    now: Date.now,
    tmpRoot: tmpdir(),
    tempDirs,
    seance: async () => {
      const dir = mkdtempSync(join(tmpdir(), "exhume-accept-stub-"));
      mkdirSync(join(dir, "seance-out"));
      writeFileSync(join(dir, "seance-out/records.jsonl"), jsonl(lines));
      tempDirs.push(dir);
      return { ok: true, value: { report: rep, tempDir: dir } };
    },
  };
}
const stubLines = (): RecordLine[] => [...setupLines(), rec(0, "batchTransfer", batchCalldata(5, TWO / 5n + 3n), A1, "exorcised")];
const stubReport = (finding: Finding = shrunk(), over: Partial<SeanceReport> = {}): SeanceReport =>
  report({ totalCalls: 5, counts: { match: 4, "reason-modernised": 0, exorcised: 1, "port-bug": 0 }, setupCalls: 4, sequenceResults: { total: 1, endedExorcised: 1, exorcisedAtIndex: [0] }, ...over }, finding);

describe("runBecAcceptance with a stubbed séance", () => {
  it("writes the report to <root>/bec/seance-report.json on a pass and removes the temp project", async () => {
    const root = tempGraveyard();
    const deps = stubDeps(root, stubReport(), stubLines());
    const r = await runBecAcceptance(deps);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.reportPath).toBe(join(root, "bec", "seance-report.json"));
    expect(readFileSync(r.value.reportPath, "utf8")).toBe(serializeReport(stubReport()));
    expect(parseReport(readFileSync(r.value.reportPath, "utf8")).ok).toBe(true);
    expect(r.value.summary).toMatchObject({ firstExorcismFuzzOrdinal: 1, receivers: 5, balanceApproximate: false, senderLegacyBalance: SHARE.toString() });
    expect(existsSync(deps.tempDirs[0]!)).toBe(false);
  });

  it("returns ACCEPTANCE_FAILED and leaves an existing report byte-identical", async () => {
    const root = tempGraveyard();
    const path = join(root, "bec", "seance-report.json");
    const before = Buffer.from('{"sentinel": "previous report"}\n');
    writeFileSync(path, before);
    const r = await runBecAcceptance(stubDeps(root, stubReport(unshrunkFinding("replay-mismatch")), stubLines()));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("ACCEPTANCE_FAILED");
    expect((r.error.details as { failed: { condition: string }[] }).failed.map((x) => x.condition)).toEqual(["unshrunk"]);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("does not create a report when none existed and acceptance fails", async () => {
    const root = tempGraveyard();
    const r = await runBecAcceptance(stubDeps(root, stubReport(shrunk(), { counts: { match: 3, "reason-modernised": 0, exorcised: 1, "port-bug": 1 } }), stubLines()));
    expect(r.ok).toBe(false);
    expect(existsSync(join(root, "bec", "seance-report.json"))).toBe(false);
  });

  it("returns a runSeance error unchanged", async () => {
    const root = tempGraveyard();
    const error = { code: "TIMEOUT" as const, phase: "discovery" as const, message: "deadline" };
    const deps = { ...stubDeps(root, stubReport(), stubLines()), seance: async () => ({ ok: false as const, error }) };
    const r = await runBecAcceptance(deps);
    expect(r).toEqual({ ok: false, error });
  });

  it("returns SOLC_MISSING from the real runSeance when solc 0.4.19 is absent", async () => {
    const root = tempGraveyard();
    const r = await runBecAcceptance({ graveyardRoot: root, runner: createProcessRunner(), now: Date.now, tmpRoot: tmpdir(), solcInstalled: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SOLC_MISSING");
  });
});

// --- real forge ----------------------------------------------------------------
const solc = listInstalledSolc();
const skip = skipReason !== "" ? skipReason : !solc.includes("0.4.19") ? "solc 0.4.19 is not installed" : "";

describe.skipIf(skip !== "")(`BEC acceptance with native forge${skip ? ` (skipped: ${skip})` : ""}`, () => {
  it(
    "passes on graveyard/bec and writes the report into a temp graveyard root",
    async () => {
      const root = tempGraveyard();
      const t0 = Date.now();
      const r = await runBecAcceptance({
        graveyardRoot: root,
        runner: createProcessRunner(),
        now: Date.now,
        tmpRoot: root,
        forgeStdDir: LOCAL_STD,
      });
      const ms = Date.now() - t0;
      if (!r.ok) {
        // eslint-disable-next-line no-console
        console.log(`[13.2 acceptance] FAILED after ${ms} ms:\n${JSON.stringify(r.error, null, 2)}`);
        throw new Error(`${r.error.code}: ${r.error.message}`);
      }
      const s = r.value.summary;
      // eslint-disable-next-line no-console
      console.log(
        `[13.2 acceptance] passed in ${ms} ms\n` +
          JSON.stringify({ ...s, totalCalls: r.value.report.totalCalls, setupCalls: r.value.report.setupCalls, counts: r.value.report.counts }, null, 2),
      );
      expect(r.value.reportPath).toBe(join(root, "bec", "seance-report.json"));
      expect(parseReport(readFileSync(r.value.reportPath, "utf8")).ok).toBe(true);
      expect(s.firstExorcismFuzzOrdinal).toBeLessThanOrEqual(BEC_FUZZ_BUDGET);
      expect(s.receivers).toBeGreaterThanOrEqual(2);
      expect(s.receivers).toBeLessThanOrEqual(20);
    },
    180_000,
  );
});
