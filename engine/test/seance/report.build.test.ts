import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { generateTargets } from "../../src/seance/input-generator.js";
import {
  REPORT_FILE_NAME,
  assignDispositions,
  attributeSite,
  buildReport,
  parseRecords,
  parseReport,
  pairKey,
  selectFindingPairs,
  serializeReport,
  validateReport,
  writeReportAtomic,
  type BuildReportArgs,
  type PairProgress,
  type ParsedRecords,
} from "../../src/seance/report.js";
import type {
  AbiFunction,
  ArithmeticSite,
  AutopsyReport,
  Operand,
  RecordLine,
  SeanceReport,
  TargetPlan,
} from "../../src/seance/types.js";

// --- fixtures ---------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const fixtureText = readFileSync(join(here, "../fixtures/records/token-small.jsonl"), "utf8");
const fixtureRecords = fixtureText
  .split("\n")
  .filter((l) => l.length > 0)
  .map((l) => JSON.parse(l) as RecordLine);

function loadFixture(): ParsedRecords {
  const runs = fixtureRecords.filter((r) => r.idx === 0).length;
  const r = parseRecords(fixtureText, runs);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const abiFn = (name: string, inputs: [string, string][]): AbiFunction => ({
  type: "function",
  name,
  inputs: inputs.map(([n, type]) => ({ name: n, type })),
  stateMutability: "nonpayable",
});
const ABI: AbiFunction[] = [
  abiFn("transfer", [["_to", "address"], ["_value", "uint256"]]),
  abiFn("batchTransfer", [["_receivers", "address[]"], ["_value", "uint256"]]),
  abiFn("bigFn", [["x", "uint256"], ["y", "uint256"]]),
  abiFn("narrow", [["a", "uint8"], ["b", "uint8"]]),
  abiFn("minus", [["a", "uint256"], ["b", "uint256"]]),
];
const loc = (line: number) => ({ file: "BecToken.sol", line, column: 5 });
const param = (name: string, type = "uint256"): Operand => ({ kind: "param", name, type });
const site = (id: string, fn: string, operator: ArithmeticSite["operator"], a: Operand, b: Operand, line: number): ArithmeticSite => ({
  id,
  function: fn,
  operator,
  operands: [a, b],
  location: loc(line),
});
const AUTOPSY: AutopsyReport = {
  schemaVersion: "1",
  contract: "BecToken",
  sites: [
    site("transfer:_value+_value", "transfer", "+", param("_value"), param("_value"), 100),
    site("batchTransfer:cnt*_value", "batchTransfer", "*", { kind: "arrayLength", name: "_receivers", type: "uint256" }, param("_value"), 257),
    site("bigFn:x*y", "bigFn", "*", param("x"), param("y"), 300),
    site("narrow:a+b", "narrow", "+", param("a", "uint8"), param("b", "uint8"), 310),
    site("minus:a-b", "minus", "-", param("a"), param("b"), 320),
    site("transfer:opaque", "transfer", "*", { kind: "unknown", type: "uint256" }, { kind: "unknown", type: "uint256" }, 330),
  ],
};
function makePlan(): TargetPlan {
  const r = generateTargets(AUTOPSY, ABI, new Set(["bigFn"]));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
const PLAN = makePlan();

const w = (n: bigint | number): string => BigInt(n).toString(16).padStart(64, "0");
const addr = (n: number): string => w(n);
/** batchTransfer(address[] _receivers, uint256 _value) calldata. */
function batchCalldata(len: number, value: bigint): string {
  const receivers = Array.from({ length: len }, (_, i) => addr(0xd0 + i)).join("");
  return `0x83f12fec${w(0x40)}${w(value)}${w(len)}${receivers}`;
}
const twoWords = (sel: string, a: bigint, b: bigint): string => `0x${sel}${w(a)}${w(b)}`;

function progressFor(parsed: ParsedRecords, replayCalldata?: string): PairProgress {
  const pairs = selectFindingPairs(parsed);
  const outcomes: PairProgress["outcomes"] = new Map();
  const done = new Set<string>();
  for (const p of pairs) {
    if (p.setup) continue;
    const base = p.first;
    const record = replayCalldata === undefined ? base : { ...base, calldata: replayCalldata };
    outcomes.set(pairKey(p), { witness: "failed", originalLength: 7, replay: { record, preceding: [] } });
    done.add(pairKey(p));
  }
  return { witnessDone: done, replayDone: new Set(done), deadlineReached: false, outcomes };
}

function args(over: Partial<BuildReportArgs> = {}, parsed = loadFixture(), replayCalldata?: string): BuildReportArgs {
  const pairs = selectFindingPairs(parsed);
  return {
    contract: "BecToken",
    seed: "0x2a",
    parsed,
    dispositions: assignDispositions(pairs, progressFor(parsed, replayCalldata)),
    autopsy: AUTOPSY,
    abi: ABI,
    plan: PLAN,
    skippedFunctions: [{ name: "bigFn", reason: "stack" }],
    ...over,
  };
}
const build = (over: Partial<BuildReportArgs> = {}): SeanceReport => buildReport(args(over));
/** Independent scan of the raw records: first exorcised fuzz line, counted among kept fuzz lines (a first exorcism has no earlier exorcised record to truncate after). */
function scanFirstExorcismOrdinal(records: RecordLine[], runs: number): number | null {
  let seq = -1;
  let ordinal = 0;
  for (const r of records) {
    if (r.idx === -1) continue;
    if (r.idx === 0) {
      seq++;
    }
    if (seq >= runs) return null; // replay tail
    ordinal++;
    if (r.classification === "exorcised") return ordinal;
  }
  return null;
}
function mutateFixture(f: (r: RecordLine, i: number) => RecordLine): string {
  return fixtureRecords.map((r, i) => JSON.stringify(f(r, i))).join("\n") + "\n";
}
function buildFrom(text: string, runs: number): SeanceReport {
  const p = parseRecords(text, runs);
  if (!p.ok) throw new Error(p.error.message);
  return buildReport(args({}, p.value));
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// --- buildReport ------------------------------------------------------------

describe("buildReport on the token-small fixture", () => {
  const report = build();

  it("copies counts and totals from the parsed records, and the counts sum to totalCalls", () => {
    const parsed = loadFixture();
    expect(report.counts).toEqual(parsed.counts);
    expect(report.totalCalls).toBe(parsed.totalCalls);
    expect(report.setupCalls).toBe(parsed.setupCalls);
    expect(report.taintedCalls).toBe(parsed.taintedCalls);
    expect(report.sequenceResults).toEqual(parsed.sequenceResults);
    const sum = Object.values(report.counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(report.totalCalls);
    expect(report.runs).toBe(256);
    expect(report.depth).toBe(64);
    expect(report.seed).toBe("0x2a");
  });

  it("reports one shrunk batchTransfer exorcism attributed to the cnt * _value site", () => {
    expect(report.exorcisms).toHaveLength(1);
    const f = report.exorcisms[0]!;
    expect(f.function).toBe("batchTransfer");
    expect(f.classification).toBe("exorcised");
    expect(f.originalLength).toBe(7);
    expect(f.unshrunk).toBeUndefined();
    expect(f.site).toEqual({ id: "batchTransfer:cnt*_value", location: loc(257) });
    expect(report.portBugs).toEqual([]);
    expect(report.shrinking).toMatchObject({ pairsFound: 1, pairsShrunk: 1, pairsSetup: 0, deadlineReached: false });
  });

  it("lists unreachable sites in autopsy order, once each, including skipped-function sites", () => {
    expect(report.unreachableSites).toEqual(["bigFn:x*y", "transfer:opaque"]);
    // Even when the plan was built without the skip set, the skipped function's sites are listed.
    const noSkip = generateTargets(AUTOPSY, ABI);
    if (!noSkip.ok) throw new Error("plan");
    const r = build({ plan: noSkip.value });
    expect(r.unreachableSites).toEqual(["bigFn:x*y", "transfer:opaque"]);
  });

  it("sorts and de-duplicates skippedFunctions, and keeps the field when empty", () => {
    const r = build({
      skippedFunctions: [
        { name: "zeta", reason: "stack" },
        { name: "bigFn", reason: "stack" },
        { name: "zeta", reason: "stack" },
      ],
    });
    expect(r.skippedFunctions).toEqual([
      { name: "bigFn", reason: "stack" },
      { name: "zeta", reason: "stack" },
    ]);
    expect(build({ skippedFunctions: [] }).skippedFunctions).toEqual([]);
  });

  it("marks the site unattributed when the shrunk calldata overflows no site", () => {
    const r = buildReport(args({}, loadFixture(), batchCalldata(2, 1n)));
    expect(r.exorcisms[0]!.site).toBe("unattributed");
    expect(validateReport(r).ok).toBe(true);
  });

  it("throws on a pending disposition", () => {
    const parsed = loadFixture();
    const pending = assignDispositions(selectFindingPairs(parsed));
    expect(() => buildReport(args({ dispositions: pending }))).toThrow(/pending/);
  });

  it("sets firstExorcismFuzzOrdinal to the first exorcised fuzz record, found by scanning the JSONL", () => {
    // Line 8 is the first fuzz record (ordinal 1), line 9 the first exorcised one (ordinal 2).
    expect(scanFirstExorcismOrdinal(fixtureRecords, 5)).toBe(2);
    expect(report.firstExorcismFuzzOrdinal).toBe(2);
  });
  it("is null when no fuzz record is exorcised", () => {
    const text = mutateFixture((r, i) => (i >= 7 && r.classification === "exorcised" ? { ...r, classification: "match" } : r));
    const r = buildFrom(text, 5);
    expect(r.counts.exorcised).toBe(0);
    expect(r.firstExorcismFuzzOrdinal).toBeNull();
    expect(validateReport(r).ok).toBe(true);
  });
  it("is null for a setup-only exorcism, which still counts in counts.exorcised", () => {
    const text = mutateFixture((r, i) => (i === 1 ? { ...r, classification: "exorcised" } : i >= 7 && r.classification === "exorcised" ? { ...r, classification: "match" } : r));
    const r = buildFrom(text, 5);
    expect(r.counts.exorcised).toBe(1);
    expect(r.firstExorcismFuzzOrdinal).toBeNull();
    expect(r.exorcisms.every((f) => f.unshrunk === true && f.unshrunkReason === "setup")).toBe(true);
    expect(validateReport(r).ok).toBe(true);
  });
  it("ignores the replay tail and records after an exorcism in the same sequence", () => {
    // Lines 9, 11 and 13 become matches, so the first exorcism is line 19 (sequence 4, ordinal 12).
    const text = mutateFixture((r, i) => ([8, 10, 12].includes(i) ? { ...r, classification: "match" } : r));
    const expected = scanFirstExorcismOrdinal(JSON.parse(`[${text.trim().split("\n").join(",")}]`) as RecordLine[], 4);
    expect(expected).toBe(12);
    // runs = 4: lines 20-25 are the replay tail, which also holds an exorcised record.
    expect(buildFrom(text, 4).firstExorcismFuzzOrdinal).toBe(12);
  });
  it("is accepted by validateReport", () => {
    const v = validateReport(report);
    expect(v.ok).toBe(true);
  });
});

describe("buildReport with a port bug", () => {
  const wire = (data: string) => ({ success: true, data, logs: [], stateHash: "0x00" });
  const bug: RecordLine = {
    idx: 0,
    function: "transfer",
    selector: "0xa9059cbb",
    calldata: twoWords("a9059cbb", 1n, 2n),
    sender: "0x" + "aa".repeat(20),
    value: "0",
    legacy: wire("0x01"),
    port: { ...wire("0x00"), stateFields: { balance: "0x01" } },
    classification: "port-bug",
    differingFields: ["returnData", "state.balance"],
    invalidRecord: false,
    afterDivergence: false,
  };
  const parsedR = parseRecords(JSON.stringify(bug) + "\n", 1);
  if (!parsedR.ok) throw new Error(parsedR.error.message);

  const deadline: PairProgress = { witnessDone: new Set(), replayDone: new Set(), deadlineReached: true, outcomes: new Map() };

  it("carries both Call_Records and differingFields, with the unshrunk markers and no site", () => {
    const r = buildReport(
      args({ parsed: parsedR.value, dispositions: assignDispositions(selectFindingPairs(parsedR.value), deadline) }),
    );
    expect(r.exorcisms).toEqual([]);
    const f = r.portBugs[0]!;
    expect(f.classification).toBe("port-bug");
    expect(f.legacy).toEqual(bug.legacy);
    expect(f.port).toEqual(bug.port);
    expect(f.differingFields).toEqual(["returnData", "state.balance"]);
    expect(f.unshrunk).toBe(true);
    expect(f.unshrunkReason).toBe("deadline");
    expect(f.originalLength).toBeUndefined();
    expect(f.site).toBeUndefined();
    expect(r.shrinking).toMatchObject({ pairsFound: 1, pairsUnshrunk: 1, deadlineReached: true });
    expect(validateReport(r).ok).toBe(true);
  });
});

// --- attributeSite ----------------------------------------------------------

describe("attributeSite", () => {
  const at = (fn: string, calldata: string) => attributeSite(fn, calldata, AUTOPSY, ABI, PLAN);

  it("attributes a BEC-style overflow through the array length and the value slot", () => {
    expect(at("batchTransfer", batchCalldata(16, 1n << 252n))).toMatchObject({ id: "batchTransfer:cnt*_value" });
  });
  it("does not attribute when the product stays below 2^256", () => {
    expect(at("batchTransfer", batchCalldata(16, (1n << 252n) - 1n))).toBe("unattributed");
  });
  it("attributes an addition overflow and an underflow", () => {
    const M = 1n << 256n;
    expect(at("transfer", twoWords("a9059cbb", 1n, (M >> 1n) - 1n))).toBe("unattributed"); // _value + _value < 2^256
    expect(at("transfer", twoWords("a9059cbb", 1n, M >> 1n))).toMatchObject({ id: "transfer:_value+_value" });
    expect(at("minus", twoWords("11111111", 1n, 2n))).toMatchObject({ id: "minus:a-b" });
    expect(at("minus", twoWords("11111111", 2n, 1n))).toBe("unattributed");
  });
  it("uses the narrow operand width for N", () => {
    expect(at("narrow", twoWords("22222222", 200n, 56n))).toMatchObject({ id: "narrow:a+b" });
    expect(at("narrow", twoWords("22222222", 200n, 55n))).toBe("unattributed");
  });
  it("is unattributed for unknown operands, short calldata, and a bad array offset", () => {
    expect(at("transfer", twoWords("a9059cbb", 1n, 2n))).toBe("unattributed"); // the unknown-operand site is never chosen
    expect(at("batchTransfer", "0x83f12fec")).toBe("unattributed");
    expect(at("batchTransfer", `0x83f12fec${w(1n << 200n)}${w(5)}`)).toBe("unattributed");
    expect(at("nope", "0x")).toBe("unattributed");
  });
  it("attributes the first overflowing site in autopsy order", () => {
    const two: AutopsyReport = {
      ...AUTOPSY,
      sites: [
        site("minus:a-b", "minus", "-", param("a"), param("b"), 1),
        site("minus:b-a", "minus", "-", param("b"), param("a"), 2),
      ],
    };
    const plan = generateTargets(two, ABI);
    if (!plan.ok) throw new Error("plan");
    expect(attributeSite("minus", twoWords("11111111", 1n, 2n), two, ABI, plan.value)).toMatchObject({ id: "minus:a-b" });
    expect(attributeSite("minus", twoWords("11111111", 2n, 1n), two, ABI, plan.value)).toMatchObject({ id: "minus:b-a" });
  });
});

// --- validateReport ---------------------------------------------------------

describe("validateReport", () => {
  const good = build();
  const rejects = (name: string, mutate: (r: any) => void, match: RegExp) =>
    it(`rejects ${name}`, () => {
      const r: any = clone(good);
      mutate(r);
      const v = validateReport(r);
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.error.code).toBe("SEANCE_FAILED");
        expect(v.error.message).toMatch(match);
      }
    });

  it("accepts the built report and returns it", () => {
    const v = validateReport(clone(good));
    expect(v.ok && v.value).toEqual(good);
  });
  it("rejects non-objects", () => {
    expect(validateReport(null).ok).toBe(false);
    expect(validateReport("x").ok).toBe(false);
  });
  rejects("a missing skippedFunctions", (r) => delete r.skippedFunctions, /skippedFunctions/);
  rejects("skippedFunctions out of order", (r) => (r.skippedFunctions = [{ name: "b", reason: "stack" }, { name: "a", reason: "stack" }]), /not sorted/);
  rejects("duplicate skippedFunctions names", (r) => (r.skippedFunctions = [{ name: "a", reason: "stack" }, { name: "a", reason: "stack" }]), /duplicate/);
  rejects("a non-adjacent duplicate name", (r) => (r.skippedFunctions = [{ name: "a", reason: "stack" }, { name: "b", reason: "stack" }, { name: "a", reason: "stack" }]), /not sorted|duplicate/);
  rejects("counts that do not sum to totalCalls", (r) => (r.counts.match += 1), /counts sum/);
  rejects("a pairsFound mismatch", (r) => (r.shrinking.pairsFound += 1), /pairsFound/);
  rejects("a repeated (function, classification) finding", (r) => r.exorcisms.push(clone(r.exorcisms[0])), /repeats the finding/);
  rejects("an exorcised finding in portBugs", (r) => r.portBugs.push({ ...clone(r.exorcisms[0]), function: "other" }), /expected port-bug/);
  rejects("an exorcism without a site", (r) => delete r.exorcisms[0].site, /no site/);
  rejects("a bad classification enum", (r) => (r.exorcisms[0].classification = "match"), /classification|schema/);
  rejects("a bad unshrunkReason enum", (r) => {
    delete r.exorcisms[0].originalLength;
    r.exorcisms[0].unshrunk = true;
    r.exorcisms[0].unshrunkReason = "gave-up";
  }, /unshrunkReason|schema/);
  rejects("a skippedFunctions reason other than stack", (r) => (r.skippedFunctions[0].reason = "gas"), /reason/);
  rejects("taintedCalls above totalCalls", (r) => (r.taintedCalls = r.totalCalls + 1), /taintedCalls/);
  rejects("a missing firstExorcismFuzzOrdinal", (r) => delete r.firstExorcismFuzzOrdinal, /firstExorcismFuzzOrdinal/);
  rejects("firstExorcismFuzzOrdinal 0", (r) => (r.firstExorcismFuzzOrdinal = 0), /firstExorcismFuzzOrdinal/);
  rejects("a negative firstExorcismFuzzOrdinal", (r) => (r.firstExorcismFuzzOrdinal = -3), /firstExorcismFuzzOrdinal/);
  rejects("a non-integer firstExorcismFuzzOrdinal", (r) => (r.firstExorcismFuzzOrdinal = 1.5), /firstExorcismFuzzOrdinal/);
  rejects("a string firstExorcismFuzzOrdinal", (r) => (r.firstExorcismFuzzOrdinal = "2"), /firstExorcismFuzzOrdinal/);
  rejects(
    "a non-null firstExorcismFuzzOrdinal when counts.exorcised is 0",
    (r) => {
      r.counts.match += r.counts.exorcised;
      r.counts.exorcised = 0;
    },
    /counts\.exorcised is 0/,
  );
  rejects("a firstExorcismFuzzOrdinal beyond the fuzz record count", (r) => (r.firstExorcismFuzzOrdinal = r.totalCalls - r.setupCalls + 1), /exceeds the fuzz record count/);
  rejects("a null firstExorcismFuzzOrdinal with a fuzz exorcism finding", (r) => (r.firstExorcismFuzzOrdinal = null), /not a setup finding/);
  it("accepts the fuzz record count as the largest ordinal", () => {
    const r: any = clone(good);
    r.firstExorcismFuzzOrdinal = r.totalCalls - r.setupCalls;
    expect(validateReport(r).ok).toBe(true);
  });
  rejects("an extra top-level property", (r) => (r.extra = 1), /additional/);
});

// --- serialization ----------------------------------------------------------

describe("serializeReport / parseReport", () => {
  const report = build();
  const text = serializeReport(report);

  it("emits the canonical top-level key order, 2-space indent, and one trailing newline", () => {
    expect(Object.keys(JSON.parse(text))).toEqual([
      "schemaVersion", "contract", "seed", "runs", "depth", "totalCalls", "counts", "taintedCalls", "setupCalls",
      "firstExorcismFuzzOrdinal", "exorcisms", "portBugs", "sequenceResults", "shrinking", "unreachableSites", "skippedFunctions",
    ]);
    expect(text.startsWith('{\n  "schemaVersion": "1",')).toBe(true);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(Object.keys(JSON.parse(text).exorcisms[0])).toEqual([
      "function", "classification", "calldata", "sender", "value", "precedingCalls", "originalLength", "site",
    ]);
    expect(Object.keys(JSON.parse(text).counts)).toEqual(["match", "reason-modernised", "exorcised", "port-bug"]);
  });
  it("round-trips firstExorcismFuzzOrdinal as a number and as null", () => {
    expect(JSON.parse(text).firstExorcismFuzzOrdinal).toBe(2);
    const a = parseReport(text);
    expect(a.ok && a.value.firstExorcismFuzzOrdinal).toBe(2);
    const none = buildFrom(mutateFixture((r, i) => (i >= 7 && r.classification === "exorcised" ? { ...r, classification: "match" } : r)), 5);
    const nullText = serializeReport(none);
    expect(JSON.parse(nullText).firstExorcismFuzzOrdinal).toBeNull();
    const b = parseReport(nullText);
    expect(b.ok && b.value).toEqual(none);
    expect(serializeReport(b.ok ? b.value : none)).toBe(nullText);
  });
  it("does not depend on the key order of the input", () => {
    const shuffled = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(report).reverse()))) as SeanceReport;
    expect(serializeReport(shuffled)).toBe(text);
  });
  it("round-trips byte for byte and the parsed value validates", () => {
    const p = parseReport(text);
    expect(p.ok).toBe(true);
    if (p.ok) expect(serializeReport(p.value)).toBe(text);
  });
  it("sorts stateFields keys so output is deterministic", () => {
    const r = clone(report);
    r.portBugs.push({
      function: "t", classification: "port-bug", calldata: "0x", sender: "0x" + "aa".repeat(20), value: "0", precedingCalls: [],
      unshrunk: true, unshrunkReason: "setup",
      legacy: { success: true, data: "0x", logs: [], stateHash: "0x00" },
      port: { success: true, data: "0x", logs: [], stateHash: "0x00", stateFields: { b: "0x1", a: "0x2" } },
      differingFields: ["logs"],
    });
    r.counts["port-bug"] += 1;
    r.totalCalls += 1;
    r.shrinking.pairsFound += 1;
    r.shrinking.pairsSetup += 1;
    const out = serializeReport(r);
    expect(out.indexOf('"a": "0x2"')).toBeLessThan(out.indexOf('"b": "0x1"'));
    const p = parseReport(out);
    expect(p.ok && serializeReport(p.value)).toBe(out);
  });
  it("rejects bad JSON and invalid reports", () => {
    const bad = parseReport("{nope");
    expect(!bad.ok && bad.error.code).toBe("SEANCE_FAILED");
    expect(parseReport('{"schemaVersion":"1"}').ok).toBe(false);
  });
});

// --- writeReportAtomic ------------------------------------------------------

describe("writeReportAtomic", () => {
  const roots: string[] = [];
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), "exhume-report-"));
    roots.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of roots.splice(0)) {
      try {
        chmodSync(join(d, "bec"), 0o755);
      } catch {
        /* not created */
      }
      rmSync(d, { recursive: true, force: true });
    }
  });
  const report = build();

  it("creates graveyard/<name>/seance-report.json with the serialized report and no temp files", async () => {
    const root = tmp();
    const r = await writeReportAtomic(join(root, "graveyard"), "bec", report);
    expect(r.ok).toBe(true);
    const file = join(root, "graveyard", "bec", REPORT_FILE_NAME);
    expect(readFileSync(file, "utf8")).toBe(serializeReport(report));
    expect(readdirSync(join(root, "graveyard", "bec"))).toEqual([REPORT_FILE_NAME]);
  });

  it("replaces an existing report", async () => {
    const root = tmp();
    await writeReportAtomic(root, "bec", report);
    const second = { ...clone(report), seed: "0x99" };
    expect((await writeReportAtomic(root, "bec", second)).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "bec", REPORT_FILE_NAME), "utf8")).seed).toBe("0x99");
    expect(readdirSync(join(root, "bec"))).toEqual([REPORT_FILE_NAME]);
  });

  it("writes nothing for an invalid report and leaves the old report unchanged", async () => {
    const root = tmp();
    await writeReportAtomic(root, "bec", report);
    const before = readFileSync(join(root, "bec", REPORT_FILE_NAME), "utf8");
    const broken = { ...clone(report), totalCalls: report.totalCalls + 1 };
    const r = await writeReportAtomic(root, "bec", broken);
    expect(!r.ok && r.error.code).toBe("SEANCE_FAILED");
    expect(readFileSync(join(root, "bec", REPORT_FILE_NAME), "utf8")).toBe(before);
    expect(readdirSync(join(root, "bec"))).toEqual([REPORT_FILE_NAME]);
  });

  it("returns REPORT_WRITE_FAILED, keeps the old file, and leaves no temp file when the rename fails", async () => {
    const root = tmp();
    // The target path is a non-empty directory, so rename(tmp, target) fails after the temp file is written.
    const target = join(root, "bec", REPORT_FILE_NAME);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "keep.txt"), "old");
    const r = await writeReportAtomic(root, "bec", report);
    expect(!r.ok && r.error.code).toBe("REPORT_WRITE_FAILED");
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("old");
    expect(readdirSync(join(root, "bec"))).toEqual([REPORT_FILE_NAME]);
  });

  it.skipIf(process.getuid?.() === 0)("returns REPORT_WRITE_FAILED and keeps the old report in a read-only directory", async () => {
    const root = tmp();
    await writeReportAtomic(root, "bec", report);
    const file = join(root, "bec", REPORT_FILE_NAME);
    const before = readFileSync(file, "utf8");
    chmodSync(join(root, "bec"), 0o555);
    const r = await writeReportAtomic(root, "bec", { ...clone(report), seed: "0x77" });
    expect(!r.ok && r.error.code).toBe("REPORT_WRITE_FAILED");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(join(root, "bec"))).toEqual([REPORT_FILE_NAME]);
  });

  it("returns REPORT_WRITE_FAILED when the graveyard root is a file", async () => {
    const root = tmp();
    writeFileSync(join(root, "notadir"), "x");
    const r = await writeReportAtomic(join(root, "notadir"), "bec", report);
    expect(!r.ok && r.error.code).toBe("REPORT_WRITE_FAILED");
  });

  for (const name of ["..", "../x", "a/b", "a\\b", ".hidden", "", "bec/..", "x".repeat(129), "a.b"]) {
    it(`rejects the name ${JSON.stringify(name)} without touching the disk`, async () => {
      const root = tmp();
      const r = await writeReportAtomic(root, name, report);
      expect(!r.ok && r.error.code).toBe("INVALID_INPUT");
      expect(readdirSync(root)).toEqual([]);
      expect(existsSync(join(root, "..", "x"))).toBe(false);
    });
  }
});
