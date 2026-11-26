import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assignDispositions,
  chooseReported,
  pairKey,
  parseRecords,
  selectFindingPairs,
  type Pair,
  type PairProgress,
  type ParsedRecords,
  type ShrinkOutcome,
} from "../../src/seance/report.js";
import type { Classification, RecordLine } from "../../src/seance/types.js";

const wire = (data = "0x") => ({ success: true, data, logs: [], stateHash: "0x00" });
function rec(idx: number, fn: string, classification: Classification, over: Partial<RecordLine> = {}): RecordLine {
  return {
    idx,
    function: fn,
    selector: "0x",
    calldata: `0x${fn}-${idx}-${classification}`,
    sender: "0x" + "aa".repeat(20),
    value: "0",
    legacy: wire(),
    port: wire("0x01"),
    classification,
    differingFields: classification === "port-bug" ? ["returnData"] : [],
    invalidRecord: false,
    afterDivergence: false,
    ...over,
  };
}
/** Each inner array is one fuzz sequence; `setup` lines come first. */
function parse(setup: RecordLine[], seqs: RecordLine[][]): ParsedRecords {
  const lines = [...setup, ...seqs.flat()];
  const r = parseRecords(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", Math.max(seqs.length, 1));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
const names = (ps: Pair[]) => ps.map((p) => `${p.function}:${p.classification}`);
const done = (...ps: Pair[]) => new Set(ps.map(pairKey));
const progress = (p: Partial<PairProgress>): PairProgress => ({
  witnessDone: new Set(),
  replayDone: new Set(),
  deadlineReached: false,
  outcomes: new Map(),
  ...p,
});

describe("selectFindingPairs", () => {
  it("keeps the first untainted record per pair and skips an earlier tainted one", () => {
    const parsed = parse([], [
      [rec(0, "f", "match"), rec(1, "g", "port-bug"), rec(2, "f", "port-bug", { afterDivergence: true })],
      [rec(0, "f", "port-bug", { calldata: "0xlater" }), rec(1, "f", "port-bug")],
    ]);
    const pairs = selectFindingPairs(parsed);
    expect(names(pairs)).toEqual(["g:port-bug", "f:port-bug"]);
    expect(pairs[1]!.first.calldata).toBe("0xlater");
    expect(pairs[1]!.first.afterDivergence).toBe(false);
    expect(pairs[1]!.preceding).toEqual([]);
  });

  it("excludes pairs whose records are all tainted, and match/reason-modernised records", () => {
    const parsed = parse([], [
      [
        rec(0, "f", "port-bug"),
        rec(1, "h", "port-bug", { afterDivergence: true }),
        rec(2, "k", "reason-modernised"),
        rec(3, "m", "match"),
      ],
    ]);
    expect(names(selectFindingPairs(parsed))).toEqual(["f:port-bug"]);
  });

  it("puts setup pairs first, then exorcised before port-bug, each by first ordinal", () => {
    const parsed = parse(
      [rec(-1, "constructor", "port-bug"), rec(-1, "s2", "exorcised")],
      [
        [rec(0, "a", "port-bug")],
        [rec(0, "b", "exorcised")],
        [rec(0, "c", "port-bug")],
        [rec(0, "d", "exorcised")],
      ],
    );
    const pairs = selectFindingPairs(parsed);
    expect(names(pairs)).toEqual([
      "constructor:port-bug",
      "s2:exorcised",
      "b:exorcised",
      "d:exorcised",
      "a:port-bug",
      "c:port-bug",
    ]);
    expect(pairs.map((p) => p.setup)).toEqual([true, true, false, false, false, false]);
  });

  it("treats the same function with both classes as two pairs", () => {
    const parsed = parse([], [[rec(0, "f", "port-bug")], [rec(0, "f", "exorcised")]]);
    expect(names(selectFindingPairs(parsed))).toEqual(["f:exorcised", "f:port-bug"]);
  });

  it("records the earlier calls of the same sequence as preceding", () => {
    const parsed = parse([rec(-1, "constructor", "match")], [
      [rec(0, "approve", "match"), rec(1, "x", "match"), rec(2, "transferFrom", "port-bug")],
    ]);
    const [p] = selectFindingPairs(parsed);
    expect(p!.preceding.map((r) => r.function)).toEqual(["approve", "x"]);
  });

  it("is deterministic", () => {
    const parsed = parse([], [[rec(0, "a", "port-bug"), rec(1, "b", "exorcised")]]);
    expect(selectFindingPairs(parsed)).toEqual(selectFindingPairs(parsed));
  });

  it("selects (batchTransfer, exorcised) only from the token-small fixture", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(join(dir, "../fixtures/records/token-small.jsonl"), "utf8");
    // runs: count of idx 0 lines, so no tail is stripped.
    const runs = text.split("\n").filter((l) => l.startsWith('{"idx":0,')).length;
    const r = parseRecords(text, runs);
    if (!r.ok) throw new Error(r.error.message);
    expect(names(selectFindingPairs(r.value))).toEqual(["batchTransfer:exorcised"]);
  });
});

/** n fuzz pairs (alternating nothing special: all port-bug in separate functions) plus setup pairs. */
function manyPairs(fuzz: number, setupN: number): Pair[] {
  const setup = Array.from({ length: setupN }, (_, i) => rec(-1, `setup${i}`, "exorcised"));
  const seqs = Array.from({ length: fuzz }, (_, i) => [rec(0, `f${String(i).padStart(2, "0")}`, "port-bug")]);
  return selectFindingPairs(parse(setup, seqs));
}

const shrunkOutcome = (pair: Pair, cls: Classification = pair.classification): ShrinkOutcome => ({
  witness: "failed",
  originalLength: 7,
  replay: {
    record: rec(2, pair.function, cls, { calldata: "0xshrunk" }),
    preceding: [rec(0, "approve", "match", { calldata: "0xapprove" }), rec(1, "other", "match")],
  },
});

describe("assignDispositions", () => {
  it("caps at 10 fuzz pairs (12 pairs, 2 over cap) and does not count setup pairs", () => {
    const pairs = manyPairs(12, 3);
    const { dispositions, shrinking } = assignDispositions(pairs);
    const kinds = dispositions.map((d) => d.disposition);
    expect(kinds.slice(0, 3)).toEqual(["setup", "setup", "setup"]);
    expect(kinds.slice(3, 13).every((k) => k === "shrink")).toBe(true);
    expect(kinds.slice(13)).toEqual(["over-cap", "over-cap"]);
    expect(dispositions[13]!.unshrunkReason).toBe("witness-cap");
    expect(dispositions[0]!.unshrunkReason).toBe("setup");
    expect(shrinking).toMatchObject({ pairsSetup: 3, pairsOverCap: 2, pairsShrunk: 0, pairsUnshrunk: 0 });
  });

  it("assigns every final reason and satisfies the pairsFound identity", () => {
    const pairs = manyPairs(5, 1); // setup0, f00..f04
    const [, a, b, c, d, e] = pairs as [Pair, Pair, Pair, Pair, Pair, Pair];
    const outcomes = new Map<string, ShrinkOutcome>([
      [pairKey(a), shrunkOutcome(a)],
      [pairKey(b), { witness: "not-failed" }],
      [pairKey(c), shrunkOutcome(c, "exorcised")], // replay class differs
    ]);
    const { dispositions, shrinking } = assignDispositions(
      pairs,
      progress({
        witnessDone: done(a, b, c, d), // d: witness failed, replay not done
        replayDone: done(a, c),
        deadlineReached: true,
        outcomes: new Map([...outcomes, [pairKey(d), { witness: "failed" as const, originalLength: 3 }]]),
      }),
    );
    expect(dispositions.map((x) => x.disposition)).toEqual([
      "setup",
      "shrunk-confirmed",
      "witness-not-failed",
      "replay-mismatch",
      "deadline", // d: mid-replay
      "deadline", // e: never started
    ]);
    expect(e).toBeDefined();
    expect(shrinking).toEqual({
      witnessCap: 10,
      pairsFound: 6,
      pairsSetup: 1,
      pairsShrunk: 1,
      pairsUnshrunk: 4,
      pairsOverCap: 0,
      deadlineReached: true,
    });
    expect(shrinking.pairsFound).toBe(
      shrinking.pairsSetup + shrinking.pairsShrunk + shrinking.pairsUnshrunk + shrinking.pairsOverCap,
    );
  });

  it("marks a pair mid-witness as deadline and never throws; no deadline reason without the flag", () => {
    const pairs = manyPairs(12, 2);
    const dl = assignDispositions(pairs, progress({ deadlineReached: true }));
    expect(dl.shrinking.deadlineReached).toBe(true);
    expect(dl.dispositions.filter((d) => d.disposition === "deadline")).toHaveLength(10);
    expect(dl.shrinking).toMatchObject({ pairsFound: 14, pairsSetup: 2, pairsUnshrunk: 10, pairsOverCap: 2 });
    const nd = assignDispositions(pairs, progress({}));
    expect(nd.dispositions.some((d) => d.unshrunkReason === "deadline")).toBe(false);
    expect(nd.shrinking.deadlineReached).toBe(false);
  });

  it("with all pairs finished, pairsFound equals the number of pairs", () => {
    const pairs = manyPairs(12, 2);
    const fuzz = pairs.filter((p) => !p.setup).slice(0, 10);
    const outcomes = new Map(fuzz.map((p) => [pairKey(p), shrunkOutcome(p)] as const));
    const { shrinking } = assignDispositions(
      pairs,
      progress({ witnessDone: done(...fuzz), replayDone: done(...fuzz), outcomes }),
    );
    expect(shrinking.pairsFound).toBe(pairs.length);
    expect(shrinking.pairsShrunk).toBe(10);
  });

  it("is deterministic", () => {
    const pairs = manyPairs(4, 1);
    expect(assignDispositions(pairs)).toEqual(assignDispositions(pairs));
  });
});

describe("chooseReported", () => {
  const parsed = parse([rec(-1, "constructor", "match"), rec(-1, "setupBug", "exorcised")], [
    [rec(0, "approve", "match", { calldata: "0xorig-approve" }), rec(1, "batchTransfer", "exorcised", { calldata: "0xorig" })],
    [rec(0, "transferFrom", "port-bug", { calldata: "0xorig-tf" })],
  ]);
  const pairs = selectFindingPairs(parsed);
  const byName = (n: string) => pairs.find((p) => p.function === n)!;

  const choose = (p: Pair, pr?: PairProgress) => {
    const d = assignDispositions(pairs, pr).dispositions.find((x) => x.pair === p)!;
    return chooseReported(d);
  };
  const fin = (p: Pair, outcome: ShrinkOutcome | { witness: "not-failed" }, replayDone = true) =>
    progress({
      witnessDone: done(p),
      replayDone: replayDone ? done(p) : new Set(),
      outcomes: new Map([[pairKey(p), outcome as ShrinkOutcome]]),
    });

  it("confirmed: returns the shrunk sequence with originalLength", () => {
    const p = byName("batchTransfer");
    const f = choose(p, fin(p, shrunkOutcome(p)));
    expect(f).toMatchObject({ function: "batchTransfer", classification: "exorcised", calldata: "0xshrunk", originalLength: 7 });
    expect(f.unshrunk).toBeUndefined();
    expect(f.precedingCalls.map((c) => c.calldata)).toEqual(["0xapprove", "0x" + "other-1-match"]);
  });

  it("confirmed port-bug carries legacy, port and differingFields from the replay record", () => {
    const p = byName("transferFrom");
    const f = choose(p, fin(p, shrunkOutcome(p)));
    expect(f.classification).toBe("port-bug");
    if (f.classification === "port-bug") expect(f.differingFields).toEqual(["returnData"]);
  });

  it("mismatch: original sequence, unshrunk, replay-mismatch, original classification", () => {
    const p = byName("batchTransfer");
    const f = choose(p, fin(p, shrunkOutcome(p, "port-bug")));
    expect(f).toMatchObject({ classification: "exorcised", unshrunk: true, unshrunkReason: "replay-mismatch", calldata: "0xorig" });
    expect(f.originalLength).toBeUndefined();
    expect(f.precedingCalls.map((c) => c.calldata)).toEqual(["0xorig-approve"]);
  });

  it("mismatch also when the replay found no record of the function", () => {
    const p = byName("batchTransfer");
    const f = choose(p, fin(p, { witness: "failed", replay: { preceding: [] } }));
    expect(f).toMatchObject({ unshrunk: true, unshrunkReason: "replay-mismatch", calldata: "0xorig" });
  });

  it("witness not failed: original sequence", () => {
    const p = byName("batchTransfer");
    const f = choose(p, fin(p, { witness: "not-failed" }, false));
    expect(f).toMatchObject({ unshrunk: true, unshrunkReason: "witness-not-failed", calldata: "0xorig" });
  });

  it("setup: as-is, no preceding calls", () => {
    const p = byName("setupBug");
    expect(p.setup).toBe(true);
    const f = choose(p);
    expect(f).toMatchObject({ unshrunk: true, unshrunkReason: "setup", function: "setupBug", precedingCalls: [] });
  });

  it("deadline: original sequence", () => {
    const p = byName("batchTransfer");
    const f = choose(p, progress({ deadlineReached: true }));
    expect(f).toMatchObject({ unshrunk: true, unshrunkReason: "deadline", calldata: "0xorig" });
  });

  it("over-cap: original sequence", () => {
    const many = manyPairs(12, 0);
    const d = assignDispositions(many).dispositions[11]!;
    expect(chooseReported(d)).toMatchObject({ unshrunk: true, unshrunkReason: "witness-cap", function: "f11" });
  });

  it("throws for a pending pair and is deterministic otherwise", () => {
    const p = byName("batchTransfer");
    const pending = assignDispositions(pairs).dispositions.find((x) => x.pair === p)!;
    expect(() => chooseReported(pending)).toThrow();
    const a = choose(p, progress({ deadlineReached: true }));
    expect(choose(p, progress({ deadlineReached: true }))).toEqual(a);
  });
});
