import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRecords, type ParsedRecords } from "../../src/seance/report.js";
import { verifyTaint } from "../../src/seance/taint.js";
import type { Classification, RecordLine, SeanceError } from "../../src/seance/types.js";

const wire = (data = "0x") => ({ success: true, data, logs: [], stateHash: "0x00" });
function rec(idx: number, classification: Classification = "match", over: Partial<RecordLine> = {}): RecordLine {
  return {
    idx,
    function: "transfer",
    selector: "0xa9059cbb",
    calldata: "0xa9059cbb" + String(idx + 1).padStart(8, "0"),
    sender: "0x" + "aa".repeat(20),
    value: "0",
    legacy: wire(),
    port: wire(),
    classification,
    differingFields: [],
    invalidRecord: false,
    afterDivergence: false,
    ...over,
  };
}
const seq = (len: number, over: (i: number) => Partial<RecordLine> = () => ({})): RecordLine[] =>
  Array.from({ length: len }, (_, i) => rec(i, "match", over(i)));
const setup = (n: number): RecordLine[] => Array.from({ length: n }, (_, i) => rec(-1, "match", { calldata: "0x5e" + i }));
const jl = (lines: RecordLine[]): string => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

function good(jsonl: string, runs: number): ParsedRecords {
  const r = parseRecords(jsonl, runs);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
function bad(jsonl: string, runs: number): SeanceError {
  const r = parseRecords(jsonl, runs);
  if (r.ok) throw new Error("expected failure");
  return r.error;
}

describe("parseRecords: tail", () => {
  const body = [...setup(2), ...seq(3), ...seq(3), ...seq(3)];

  it("strips an exact tail and excludes it from counts and ordinals", () => {
    const p = good(jl([...body, ...seq(3)]), 3);
    expect(p.totalCalls).toBe(11);
    expect(p.setupCalls).toBe(2);
    expect(p.records.map((r) => r.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(p.records.at(-1)!.fuzzOrdinal).toBe(9);
    expect(p.counts).toEqual({ match: 11, "reason-modernised": 0, exorcised: 0, "port-bug": 0 });
    expect(p.sequenceResults.total).toBe(3);
    expect(p.tail).toEqual({ present: true, verified: true, lines: 3 });
  });

  it("keeps everything when there are <= runs sequences", () => {
    expect(good(jl(body), 3).totalCalls).toBe(11);
    const p = good(jl(body), 5);
    expect(p.totalCalls).toBe(11);
    expect(p.tail.present).toBe(false);
  });

  it.each([
    ["calldata", seq(3, (i) => (i === 1 ? { calldata: "0xdead" } : {})), 2 + 9 + 2, "calldata"],
    ["sender", seq(3, (i) => (i === 2 ? { sender: "0x" + "bb".repeat(20) } : {})), 2 + 9 + 3, "sender"],
    ["classification", seq(3, (i) => (i === 0 ? { classification: "exorcised" } : {})), 2 + 9 + 1, "classification"],
    ["afterDivergence", seq(3, (i) => (i === 0 ? { afterDivergence: true } : {})), 2 + 9 + 1, "afterDivergence"],
    ["legacy data", seq(3, (i) => (i === 0 ? { legacy: wire("0x01") } : {})), 2 + 9 + 1, "legacy.data"],
  ] as const)("tampered tail (%s) fails naming line and field", (_n, tail, line, field) => {
    const e = bad(jl([...body, ...tail]), 3);
    expect(e.code).toBe("SEANCE_FAILED");
    expect(e.message).toContain(`line ${line}`);
    expect(e.message).toContain(`field ${field}`);
  });

  it("tail shorter: missing line", () => {
    const e = bad(jl([...body, ...seq(2)]), 3);
    expect(e.code).toBe("SEANCE_FAILED");
    expect(e.message).toContain("line 14");
    expect(e.message).toContain("missing line");
  });

  it("tail longer: extra line", () => {
    const e = bad(jl([...body, ...seq(4)]), 3);
    expect(e.message).toContain("line 15");
    expect(e.message).toContain("extra line");
  });

  it("an extra idx 0 line inside the tail shows as an idx difference", () => {
    const e = bad(jl([...body, ...seq(3), ...seq(1)]), 3);
    expect(e.message).toContain("line 15");
  });
});

describe("parseRecords: lines", () => {
  it("accepts an empty input with zero counts", () => {
    const p = good("", 256);
    expect(p.totalCalls).toBe(0);
    expect(p.sequences).toEqual([]);
    expect(Object.values(p.counts)).toEqual([0, 0, 0, 0]);
    expect(p.sequenceResults.total).toBe(0);
  });

  it("discards a truncated last line", () => {
    const text = jl([...setup(1), ...seq(2)]) + '{"idx":0,"func';
    const p = good(text, 3);
    expect(p.totalCalls).toBe(3);
  });

  it("rejects bad JSON in the middle, and a complete bad last line", () => {
    const lines = [...setup(1), ...seq(2)].map((l) => JSON.stringify(l));
    lines.splice(1, 0, "{oops");
    const e = bad(lines.join("\n") + "\n", 3);
    expect(e.code).toBe("SEANCE_FAILED");
    expect(e.message).toContain("line 2");
    expect(bad(jl(seq(1)) + "{oops\n", 3).message).toContain("line 2");
  });

  it("names a missing field and a bad class", () => {
    const o = JSON.parse(JSON.stringify(rec(0))) as Record<string, unknown>;
    delete o.sender;
    expect(bad(JSON.stringify(o) + "\n", 3).message).toMatch(/line 1.*field sender/);
    expect(bad(jl([rec(0, "bogus" as Classification)]), 3).message).toMatch(/line 1.*classification/);
    expect(bad(jl([rec(-2)]), 3).message).toMatch(/line 1.*idx/);
    expect(bad(jl([rec(0, "match", { idx: 1.5 })]), 3).message).toMatch(/idx/);
  });

  it("tolerates unknown fields", () => {
    const o = { ...rec(0), extra: 1 };
    expect(good(JSON.stringify(o) + "\n", 3).totalCalls).toBe(1);
  });

  it("rejects runs < 1", () => {
    expect(bad("", 0).code).toBe("INVALID_INPUT");
  });
});

describe("parseRecords: idx continuity", () => {
  it("dropped line", () => {
    const lines = [...setup(1), ...seq(4)];
    lines.splice(3, 1); // idx 0,1,3
    const e = bad(jl(lines), 3);
    expect(e.code).toBe("SEANCE_FAILED");
    expect(e.message).toContain("line 4");
    expect(e.message).toContain("expected 2");
  });
  it("skipped idx", () => {
    expect(bad(jl([rec(0), rec(2)]), 3).message).toMatch(/line 2.*idx 2.*expected 1/);
  });
  it("sequence starting at idx > 0 (first and later)", () => {
    expect(bad(jl([rec(1), rec(2)]), 3).message).toMatch(/line 1.*idx 1.*expected 0/);
    expect(bad(jl([rec(0), rec(1), rec(0), rec(1)].slice(0, 2).concat([rec(3)])), 3).message).toMatch(/line 3/);
  });
  it("a sequence that lost its idx 0 line", () => {
    const lines = [...seq(2), ...seq(3).slice(1)]; // 0 1 | 1 2: second sequence starts at idx 1
    expect(bad(jl(lines), 3).message).toMatch(/line 3.*idx 1.*expected 2/);
  });
  it("setup records are exempt", () => {
    expect(good(jl([...setup(3), ...seq(2)]), 3).setupCalls).toBe(3);
  });
  it("checks kept lines only (a bad tail fails on the tail, not on continuity)", () => {
    const e = bad(jl([...seq(2), ...seq(2), rec(0), rec(5)]), 2);
    expect(e.message).toContain("replay tail");
    expect(e.message).toContain("line 6");
  });
});

describe("parseRecords: grouping, ordinals, counts", () => {
  it("assigns ordinal by kept line and fuzzOrdinal over idx >= 0", () => {
    const p = good(jl([...setup(2), ...seq(2), ...seq(2)]), 3);
    expect(p.records.map((r) => [r.ordinal, r.fuzzOrdinal])).toEqual([
      [1, undefined],
      [2, undefined],
      [3, 1],
      [4, 2],
      [5, 3],
      [6, 4],
    ]);
    expect(p.setupRecords).toHaveLength(2);
    expect(p.sequences.map((s) => s.length)).toEqual([2, 2]);
  });

  it("truncates a sequence at its exorcised record and records the index", () => {
    const s1 = [rec(0), rec(1, "exorcised"), rec(2), rec(3)];
    const p = good(jl([...setup(1), ...s1, ...seq(2)]), 3);
    expect(p.sequences[0]!.map((r) => r.idx)).toEqual([0, 1]);
    expect(p.exorcisedAtIndex).toEqual([1, null]);
    expect(p.sequenceResults).toEqual({ total: 2, endedExorcised: 1, exorcisedAtIndex: [1] });
    expect(p.totalCalls).toBe(1 + 2 + 2);
    expect(p.records.map((r) => r.ordinal)).toEqual([1, 2, 3, 4, 5]);
  });

  it("counts tainted records and counts sum to totalCalls", () => {
    const s = [
      rec(0, "reason-modernised"),
      rec(1, "port-bug"),
      rec(2, "match", { afterDivergence: true }),
      rec(3, "exorcised", { afterDivergence: true }),
    ];
    const p = good(jl([...setup(1), ...s]), 3);
    expect(p.counts).toEqual({ match: 2, "reason-modernised": 1, exorcised: 1, "port-bug": 1 });
    expect(p.taintedCalls).toBe(2);
    expect(Object.values(p.counts).reduce((a, b) => a + b, 0)).toBe(p.totalCalls);
    expect(verifyTaint(p.records).ok).toBe(true);
  });
});

describe("parseRecords: real forge output (token fixture, runs=4 depth=6, seed 42)", () => {
  const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../fixtures/records/token-small.jsonl"), "utf8");
  it("strips the real replay tail and the kept stream passes verifyTaint", () => {
    const p = good(text, 4);
    expect(p.tail).toEqual({ present: true, verified: true, lines: 6 });
    expect(p.totalCalls).toBe(text.trim().split("\n").length - 6);
    expect(p.sequenceResults.total).toBe(4);
    expect(Object.values(p.counts).reduce((a, b) => a + b, 0)).toBe(p.totalCalls);
    expect(verifyTaint(p.records).ok).toBe(true);
  });
  it("without the tail's worth of runs nothing is stripped", () => {
    const p = good(text, 5);
    expect(p.tail.present).toBe(false);
    expect(p.sequenceResults.total).toBe(5);
  });
  it("a tampered real tail fails", () => {
    const lines = text.trim().split("\n");
    lines[lines.length - 1] = lines[lines.length - 1]!.replace(/"sender":"0x[0-9a-fA-F]{40}"/, '"sender":"0x' + "11".repeat(20) + '"');
    const e = bad(lines.join("\n") + "\n", 4);
    expect(e.message).toContain(`line ${lines.length}`);
    expect(e.message).toContain("field sender");
  });
});
