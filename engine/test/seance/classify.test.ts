import { describe, expect, it } from "vitest";
import { classify, classifyConstructors, isPanic0x11, normalizeLogs } from "../../src/seance/classify.js";
import type { CallRecord, NormLog } from "../../src/seance/types.js";

const PANIC = "0x4e487b71" + "0".repeat(62) + "11";
const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);

const rec = (over: Partial<CallRecord> = {}): CallRecord => ({
  success: true,
  data: "0x01",
  logs: [],
  state: { balance: "0x00", "allowed(a,b)": "0x05" },
  ...over,
});
const rev = (data: string): CallRecord => rec({ success: false, data, state: {} });
const log = (over: Partial<NormLog> = {}): NormLog => ({ emitter: "SELF", topics: ["0x01"], data: "0x02", ...over });

describe("isPanic0x11", () => {
  it("accepts exactly the 36-byte encoding, any hex case", () => {
    expect(isPanic0x11(PANIC)).toBe(true);
    expect(isPanic0x11("0x4E487B71" + "0".repeat(62) + "11")).toBe(true);
  });
  it("rejects other lengths, selectors, codes, odd length, and non-strings", () => {
    expect(isPanic0x11(PANIC.slice(0, -2))).toBe(false); // 35 bytes
    expect(isPanic0x11(PANIC + "00")).toBe(false); // 37 bytes
    expect(isPanic0x11("0x4e487b72" + "0".repeat(62) + "11")).toBe(false);
    expect(isPanic0x11("0x4e487b71" + "0".repeat(62) + "12")).toBe(false);
    expect(isPanic0x11(PANIC + "0")).toBe(false);
    expect(isPanic0x11("0x")).toBe(false);
    expect(isPanic0x11(undefined)).toBe(false);
  });
});

describe("classify decision table", () => {
  it("revert/revert identical -> match", () => {
    expect(classify(rev("0xAB"), rev("0xab"))).toEqual({ classification: "match", invalidRecord: false, differingFields: [] });
  });
  it("revert/revert differing -> reason-modernised", () => {
    expect(classify(rev("0x"), rev(PANIC)).classification).toBe("reason-modernised");
    expect(classify(rev("0x01"), rev("0x02")).classification).toBe("reason-modernised");
    expect(classify(rev(PANIC), rev("0x")).classification).toBe("reason-modernised");
  });
  it("success/revert Panic(0x11) -> exorcised", () => {
    expect(classify(rec(), rev(PANIC)).classification).toBe("exorcised");
    expect(classify(rec(), rev(PANIC.toUpperCase().replace("0X", "0x"))).classification).toBe("exorcised");
  });
  it("success/revert with inexact Panic -> port-bug", () => {
    for (const d of [PANIC.slice(0, -2), PANIC + "00", "0x4e487b72" + "0".repeat(62) + "11", "0x4e487b71" + "0".repeat(62) + "12", "0x"]) {
      expect(classify(rec(), rev(d))).toEqual({
        classification: "port-bug",
        invalidRecord: false,
        differingFields: ["returnData", "success"],
      });
    }
  });
  it("revert/success -> port-bug", () => {
    expect(classify(rev("0x"), rec()).classification).toBe("port-bug");
  });
  it("success/success equal -> match, ignoring hex case", () => {
    expect(classify(rec(), rec()).classification).toBe("match");
    expect(classify(rec({ data: "0xAB" }), rec({ data: "0xab" })).classification).toBe("match");
  });
  it("differing return data -> port-bug named returnData", () => {
    expect(classify(rec(), rec({ data: "0x02" }))).toEqual({
      classification: "port-bug",
      invalidRecord: false,
      differingFields: ["returnData"],
    });
  });
  it("a single differing allowed value is a port-bug naming only that field", () => {
    const r = classify(rec(), rec({ state: { balance: "0x00", "allowed(a,b)": "0x06" } }));
    expect(r.classification).toBe("port-bug");
    expect(r.differingFields).toEqual(["state.allowed(a,b)"]);
  });
  it("differing balance, missing key and extra key are named and sorted", () => {
    const r = classify(rec({ state: { balance: "0x00", z: "0x01" } }), rec({ state: { balance: "0x01", a: "0x01" } }));
    expect(r.differingFields).toEqual(["state.a", "state.balance", "state.z"]);
  });
  it("an empty state value 0x equal on both sides is a match", () => {
    const r = classify(rec({ state: { name: "0x" } }), rec({ state: { name: "0x" } }));
    expect(r.classification).toBe("match");
    expect(r.differingFields).toEqual([]);
  });
  it("an empty state value differing from a non-empty one is a port-bug on that key", () => {
    const r = classify(rec({ state: { name: "0x" } }), rec({ state: { name: "0x00" } }));
    expect(r.classification).toBe("port-bug");
    expect(r.differingFields).toEqual(["state.name"]);
  });
  it("a 96-byte ABI-encoded string differing in one byte is a port-bug", () => {
    // offset 0x20, length 5, "Token" padded to 32 bytes
    const abi = (s: string): string =>
      "0x" + "20".padStart(64, "0") + "05".padStart(64, "0") + Buffer.from(s).toString("hex").padEnd(64, "0");
    expect(abi("Token")).toHaveLength(2 + 96 * 2);
    const same = classify(rec({ state: { name: abi("Token") } }), rec({ state: { name: abi("Token").toUpperCase().replace("0X", "0x") } }));
    expect(same.classification).toBe("match");
    const r = classify(rec({ state: { name: abi("Token") } }), rec({ state: { name: abi("Tokem") } }));
    expect(r.classification).toBe("port-bug");
    expect(r.differingFields).toEqual(["state.name"]);
  });
  it("reverted pair ignores state and logs", () => {
    const a = { ...rev("0x01"), logs: [log()], state: { x: "0x01" } };
    const b = { ...rev("0x01"), logs: [], state: { x: "0x02" } };
    expect(classify(a, b).classification).toBe("match");
  });
});

describe("differingFields for every port-bug shape", () => {
  it("success/success: data, logs and state together, sorted", () => {
    const r = classify(
      rec(),
      rec({ data: "0x02", logs: [log()], state: { balance: "0x01", "allowed(a,b)": "0x05" } }),
    );
    expect(r).toEqual({
      classification: "port-bug",
      invalidRecord: false,
      differingFields: ["logs", "returnData", "state.balance"],
    });
  });
  it("state keys named returnData or logs do not collide with the fixed names", () => {
    const r = classify(rec({ state: { returnData: "0x01", logs: "0x01" } }), rec({ state: { returnData: "0x02", logs: "0x02" } }));
    expect(r.differingFields).toEqual(["state.logs", "state.returnData"]);
    const both = classify(rec({ state: { logs: "0x01" } }), rec({ data: "0x02", logs: [log()], state: { logs: "0x02" } }));
    expect(both.differingFields).toEqual(["logs", "returnData", "state.logs"]);
  });
  it("legacy ok, port non-Panic revert: success, plus returnData when data differs", () => {
    expect(classify(rec(), rev("0x01")).differingFields).toEqual(["success"]);
    expect(classify(rec(), rev("0x0001")).differingFields).toEqual(["returnData", "success"]);
    expect(classify(rec(), rev("0x01")).classification).toBe("port-bug");
  });
  it("legacy revert, port ok: success, plus returnData when data differs", () => {
    expect(classify(rev("0x01"), rec()).differingFields).toEqual(["success"]);
    expect(classify(rev("0x"), rec()).differingFields).toEqual(["returnData", "success"]);
    expect(classify(rev("0x"), rec()).classification).toBe("port-bug");
  });
  it("one-sided cases ignore logs and state", () => {
    const ok = rec({ logs: [log()], state: { x: "0x09" } });
    expect(classify(ok, rev("0x01")).differingFields).toEqual(["success"]);
    expect(classify(rev("0x01"), ok).differingFields).toEqual(["success"]);
  });
  it("match, reason-modernised and exorcised have no fields", () => {
    expect(classify(rec(), rec()).differingFields).toEqual([]);
    expect(classify(rev("0x01"), rev("0x02")).differingFields).toEqual([]);
    expect(classify(rec(), rev(PANIC)).differingFields).toEqual([]);
  });
});

describe("log comparison", () => {
  const base = [log(), log({ topics: ["0x0a", "0x0b"], data: "0x" })];
  const withLogs = (logs: NormLog[]) => rec({ logs });
  const diff = (other: NormLog[]) => classify(withLogs(base), withLogs(other));

  it("equal logs match, hex case-insensitive", () => {
    expect(diff([log({ data: "0x02" }), log({ topics: ["0x0A", "0x0B"], data: "0x" })]).classification).toBe("match");
  });
  it.each([
    ["count", [base[0]!]],
    ["order", [base[1]!, base[0]!]],
    ["topics", [base[0]!, log({ topics: ["0x0a", "0x0c"], data: "0x" })]],
    ["data", [base[0]!, log({ topics: ["0x0a", "0x0b"], data: "0x01" })]],
    ["emitter", [log({ emitter: A }), base[1]!]],
  ])("differing %s -> port-bug naming logs", (_n, other) => {
    const r = diff(other as NormLog[]);
    expect(r.classification).toBe("port-bug");
    expect(r.differingFields).toEqual(["logs"]);
  });
  it("same non-self emitter matches, different non-self emitter does not", () => {
    expect(classify(withLogs([log({ emitter: A })]), withLogs([log({ emitter: A.toUpperCase().replace("0X", "0x") })])).classification).toBe("match");
    expect(classify(withLogs([log({ emitter: A })]), withLogs([log({ emitter: B })])).classification).toBe("port-bug");
  });
});

describe("normalizeLogs", () => {
  const LEG = "0x" + "11".repeat(20);
  const POR = "0x" + "22".repeat(20);
  const raw = (emitter: string) => [{ emitter, topics: ["0xAB"], data: "0xCD" }];

  it("maps each deployment's own address to SELF so equal logs compare equal", () => {
    const l = normalizeLogs(raw(LEG), LEG, true);
    const p = normalizeLogs(raw(POR.toUpperCase().replace("0X", "0x")), POR, true);
    expect(l).toEqual([{ emitter: "SELF", topics: ["0xab"], data: "0xcd" }]);
    expect(classify(rec({ logs: l }), rec({ logs: p })).classification).toBe("match");
  });
  it("keeps a foreign emitter (lowercased); the other deployment's address is not SELF", () => {
    const l = normalizeLogs(raw(POR), LEG, true);
    expect(l[0]!.emitter).toBe(POR);
    expect(classify(rec({ logs: normalizeLogs(raw(LEG), LEG, true) }), rec({ logs: l })).classification).toBe("port-bug");
  });
  it("returns an empty list for a reverted call and does not mutate input", () => {
    const input = raw(LEG);
    const copy = structuredClone(input);
    expect(normalizeLogs(input, LEG, false)).toEqual([]);
    normalizeLogs(input, LEG, true);
    expect(input).toEqual(copy);
  });
});

describe("malformed records", () => {
  const bad: [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["missing success", { data: "0x", logs: [], state: {} }],
    ["non-boolean success", { ...rec(), success: "true" }],
    ["missing data", { success: true, logs: [], state: {} }],
    ["non-hex data", { ...rec(), data: "0xzz" }],
    ["odd-length data", { ...rec(), data: "0x123" }],
    ["no 0x prefix", { ...rec(), data: "0102" }],
    ["unprefixed hex state value", { ...rec(), state: { balance: "00" } }],
    ["odd-length state value", { ...rec(), state: { balance: "0x0" } }],
    ["unprefixed log topic", { ...rec(), logs: [{ emitter: "SELF", topics: ["01"], data: "0x" }] }],
    ["odd-length log data", { ...rec(), logs: [{ emitter: "SELF", topics: [], data: "0x123" }] }],
    ["missing logs", { success: true, data: "0x", state: {} }],
    ["bad log", { ...rec(), logs: [{ emitter: "SELF", topics: "0x01", data: "0x" }] }],
    ["missing state", { success: true, data: "0x", logs: [] }],
    ["non-hex state value", { ...rec(), state: { balance: 5 } }],
  ];
  it.each(bad)("%s -> port-bug with invalidRecord, on either side", (_n, r) => {
    const expected = { classification: "port-bug", invalidRecord: true, differingFields: [] };
    expect(classify(r, rec())).toEqual(expected);
    expect(classify(rec(), r)).toEqual(expected);
    expect(classify(r, r)).toEqual(expected);
  });
});

describe("purity", () => {
  it("returns equal results twice and leaves inputs unchanged", () => {
    const a = rec({ logs: [log()] });
    const b = rec({ data: "0x02", logs: [log({ data: "0x09" })] });
    const [ac, bc] = [structuredClone(a), structuredClone(b)];
    expect(classify(a, b)).toEqual(classify(a, b));
    expect(a).toEqual(ac);
    expect(b).toEqual(bc);
  });
});

describe("classifyConstructors", () => {
  const ok = { success: true, data: "0x" };
  const r = (data: string) => ({ success: false, data });

  it("one-sided revert -> port-bug, reports the reverting side's data, ends", () => {
    expect(classifyConstructors(ok, r("0xAA"))).toEqual({
      classification: "port-bug", endSeance: true, invalidRecord: false, reverted: { side: "port", data: "0xAA" },
    });
    expect(classifyConstructors(r("0xbb"), ok)).toEqual({
      classification: "port-bug", endSeance: true, invalidRecord: false, reverted: { side: "legacy", data: "0xbb" },
    });
  });
  it("both revert identical -> match and ends", () => {
    expect(classifyConstructors(r("0xAB"), r("0xab"))).toMatchObject({ classification: "match", endSeance: true });
  });
  it("both revert differing (including empty vs non-empty) -> reason-modernised and ends", () => {
    expect(classifyConstructors(r("0x"), r("0x01"))).toMatchObject({ classification: "reason-modernised", endSeance: true });
  });
  it("both succeed -> match and the séance continues", () => {
    expect(classifyConstructors(ok, ok)).toEqual({ classification: "match", endSeance: false, invalidRecord: false });
  });
  it("malformed outcome -> port-bug, invalidRecord, ends", () => {
    expect(classifyConstructors(undefined, ok)).toEqual({ classification: "port-bug", endSeance: true, invalidRecord: true });
    expect(classifyConstructors({ success: 1, data: "0x" }, ok).invalidRecord).toBe(true);
  });
});
