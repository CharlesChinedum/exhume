import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseCounterexample, testStatus } from "../../src/seance/foundry-json.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/forge-json/${name}.json`, import.meta.url), "utf8"));

const SENDER = "0x000000000000000000000000000000000000127f";
const call = (over: Record<string, unknown> = {}) => ({
  sender: SENDER,
  addr: "0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f",
  calldata: "0x20c69c89",
  contract_name: "test/Witness.t.sol:WitnessHandler",
  func_name: "arm",
  signature: "arm(uint256)",
  args: "1",
  raw_args: "1",
  ...over,
});
const result = (counterexample: unknown, status = "Failure", reason: string | null = "witness hit") => ({
  status,
  reason,
  counterexample,
});
const wrap = (results: Record<string, unknown>, key = "test/Witness.t.sol:Witness1") => ({
  [key]: { duration: "1ms", test_results: results },
});
const seqResult = (calls: unknown[], n = 5) => result({ Sequence: [n, calls] });

function expectFailed(json: unknown, pathPart: string, opts?: { contract?: string; test?: string }) {
  const r = parseCounterexample(json, opts);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.error.code).toBe("SEANCE_FAILED");
    expect(r.error.message).toContain(pathPart);
  }
}

describe("parseCounterexample on saved fixtures", () => {
  it("failing.json gives found, originalLength 15, arm then fire", () => {
    const r = parseCounterexample(fixture("failing"));
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.kind !== "found") throw new Error("expected found");
    expect(r.value.originalLength).toBe(15);
    expect(r.value.calls.map((c) => c.funcName)).toEqual(["arm", "fire"]);
    const [arm, fire] = r.value.calls;
    expect(arm?.calldata).toBe("0x20c69c890000000000000000000000000000000000000000000000000000000000001931");
    expect(arm?.sender).toBe("0x000000000000000000000000000000000000127f");
    expect(arm?.signature).toBe("arm(uint256)");
    expect(arm?.args).toEqual(["6449"]);
    expect(arm?.rawArgs).toBe("6449");
    expect(arm?.addr).toBe("0x5615deb798bb3e4dfa0139dfa1b3d433cc23b72f");
    expect(arm?.contractName).toBe("test/Witness.t.sol:WitnessHandler");
    expect(fire?.sender).toBe("0x00000000000000000000000000000000000001c7");
  });

  it("passing.json gives none", () => {
    expect(parseCounterexample(fixture("passing"))).toEqual({ ok: true, value: { kind: "none" } });
  });

  it("is deterministic", () => {
    const j = fixture("failing");
    expect(parseCounterexample(j)).toEqual(parseCounterexample(j));
  });

  it("testStatus reads the selected status", () => {
    expect(testStatus(fixture("failing"))).toEqual({ ok: true, value: "Failure" });
    expect(testStatus(fixture("passing"))).toEqual({ ok: true, value: "Success" });
  });
});

describe("parseCounterexample selection", () => {
  it("parses a cache-replay-style result", () => {
    const calls = [call(), call({ func_name: "fire" })];
    const json = wrap({
      "invariant_witness()": result({ Sequence: [2, calls] }, "Failure", "invariant_witness replay failure"),
    });
    const r = parseCounterexample(json);
    expect(r.ok && r.value.kind === "found" && r.value.originalLength).toBe(2);
  });

  it("does not depend on key order", () => {
    const a = wrap({ "invariant_witness()": seqResult([call()]) }, "test/A.t.sol:A");
    const b = wrap({ "invariant_witness()": seqResult([call()]) }, "test/B.t.sol:B");
    const json1 = { ...a, ...b };
    const json2 = { ...b, ...a };
    expectFailed(json1, "more than one");
    expect(parseCounterexample(json1)).toEqual(parseCounterexample(json2));
    const f1 = parseCounterexample(json1, { contract: "B" });
    const f2 = parseCounterexample(json2, { contract: "test/B.t.sol:B" });
    expect(f1.ok).toBe(true);
    expect(f1).toEqual(f2);
  });

  it("ignores other tests when filtered by name", () => {
    const json = wrap({
      "invariant_a()": seqResult([call()], 3),
      "invariant_witness()": result(null, "Success", null),
    });
    expect(parseCounterexample(json, { test: "invariant_witness" })).toEqual({ ok: true, value: { kind: "none" } });
    const a = parseCounterexample(json, { test: "invariant_a()" });
    expect(a.ok && a.value.kind).toBe("found");
  });

  it("rejects ambiguous invariant results without a filter, listing them", () => {
    const json = wrap({ "invariant_a()": seqResult([call()]), "invariant_b()": seqResult([call()]) });
    const r = parseCounterexample(json);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error.details)).toContain("invariant_b()");
  });

  it("ignores non-invariant tests and fails when no invariant result exists", () => {
    expectFailed(wrap({ "testFoo()": result(null) }), "no matching invariant");
  });
});

describe("parseCounterexample malformed shapes", () => {
  const T = "invariant_witness()";
  const ce = (c: unknown, status = "Failure") => wrap({ [T]: result(c, status) });
  const p = '["test/Witness.t.sol:Witness1"].test_results["invariant_witness()"].counterexample';

  it("rejects empty and non-object input", () => {
    for (const j of [{}, null, [], "x", 5, undefined]) expectFailed(j, "forge JSON");
  });
  it("rejects a missing counterexample key", () => {
    expectFailed(wrap({ [T]: { status: "Failure" } }), `${T}"].counterexample is missing`);
  });
  it("rejects Sequence that is not an array", () => expectFailed(ce({ Sequence: {} }), `${p}.Sequence`));
  it("rejects Sequence of length 1 and 3", () => {
    expectFailed(ce({ Sequence: [1] }), `${p}.Sequence`);
    expectFailed(ce({ Sequence: [1, [], 2] }), `${p}.Sequence`);
  });
  it("rejects a bad originalLength", () => {
    for (const n of [-1, 1.5, "3", null]) expectFailed(ce({ Sequence: [n, []] }), `${p}.Sequence[0]`);
  });
  it("rejects calls that are not an array", () => expectFailed(ce({ Sequence: [1, {}] }), `${p}.Sequence[1]`));
  it("rejects a call missing func_name, calldata or sender", () => {
    for (const f of ["func_name", "calldata", "sender"]) {
      const c: Record<string, unknown> = call();
      delete c[f];
      expectFailed(ce({ Sequence: [2, [call(), c]] }), `${p}.Sequence[1][1].${f}`);
    }
  });
  it("rejects odd-length and non-hex calldata", () => {
    for (const cd of ["0x123", "0xzz", "1234", "0x12g4"]) {
      expectFailed(ce({ Sequence: [1, [call({ calldata: cd })]] }), "[0].calldata");
    }
  });
  it("rejects a sender of the wrong length", () => {
    expectFailed(ce({ Sequence: [1, [call({ sender: "0x1234" })]] }), "[0].sender");
  });
  it("rejects other counterexample forms", () => {
    expectFailed(ce("boom"), p);
    expectFailed(ce({ calldata: "0x12" }), p);
    expectFailed(ce([]), p);
  });
  it("rejects a non-null counterexample on a non-Failure status", () => {
    expectFailed(ce({ Sequence: [1, []] }, "Success"), "status is not Failure");
  });
});

describe("parseCounterexample property", () => {
  const hex = (bytes: number) => fc.uint8Array({ minLength: bytes, maxLength: bytes }).map((a) => Buffer.from(a).toString("hex"));
  const genCall = fc.record({
    func_name: fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,11}$/),
    calldata: fc.uint8Array({ minLength: 0, maxLength: 80 }).map((a) => "0x" + Buffer.from(a).toString("hex")),
    sender: hex(20).map((h) => "0x" + h),
    addr: hex(20).map((h) => "0x" + h),
    contract_name: fc.constant("test/Witness.t.sol:WitnessHandler"),
    signature: fc.constant("f(uint256)"),
    args: fc.string(),
    raw_args: fc.string(),
  });

  it("recovers the generated calls in order and originalLength", () => {
    fc.assert(
      fc.property(fc.nat(100000), fc.array(genCall, { maxLength: 12 }), (n, calls) => {
        const r = parseCounterexample(wrap({ "invariant_witness()": seqResult(calls, n) }));
        expect(r.ok).toBe(true);
        if (!r.ok || r.value.kind !== "found") return false;
        expect(r.value.originalLength).toBe(n);
        expect(r.value.calls.map((c) => [c.funcName, c.calldata, c.sender, c.addr, c.rawArgs])).toEqual(
          calls.map((c) => [c.func_name, c.calldata, c.sender, c.addr, c.raw_args]),
        );
        return true;
      }),
    );
  });
});
