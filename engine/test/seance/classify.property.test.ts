/**
 * Property 8: Classification follows the decision table.
 *
 * **Validates: Requirements 3.4, 3.8, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 10.5**
 *
 * The test carries its own small reference model (`oracle`), a straight table
 * lookup written against the design, not against classify.ts. It compares bytes
 * (via Buffer) rather than lowercased strings.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import vectors from "../vectors/classification.json" with { type: "json" };
import { classify, normalizeLogs, type RawLog } from "../../src/seance/classify.js";
import { CLASSIFICATIONS, type CallRecord, type NormLog } from "../../src/seance/types.js";

const NUM_RUNS = 500;

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

const PANIC_BYTES = Buffer.from("4e487b71" + "00".repeat(31) + "11", "hex");

const bytes = (h: string): Buffer => Buffer.from(h.slice(2), "hex");
const sameBytes = (a: string, b: string): boolean => bytes(a).equals(bytes(b));
const isPanic = (h: string): boolean => bytes(h).equals(PANIC_BYTES);

const logKey = (l: NormLog): string =>
  JSON.stringify([l.emitter === "SELF" ? "SELF" : l.emitter.toLowerCase(), l.topics.map((t) => t.toLowerCase()), l.data.toLowerCase()]);
const sameLogs = (a: NormLog[], b: NormLog[]): boolean => JSON.stringify(a.map(logKey)) === JSON.stringify(b.map(logKey));

function differingStateKeys(a: Record<string, string>, b: Record<string, string>): string[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.filter((k) => !(k in a) || !(k in b) || !sameBytes(a[k]!, b[k]!)).map((k) => `state.${k}`);
}

interface Expected {
  classification: string;
  differingFields: string[];
}

function oracle(l: CallRecord, p: CallRecord): Expected {
  const sorted = (xs: string[]): string[] => [...new Set(xs)].sort();
  const dataDiffers = !sameBytes(l.data, p.data);
  const none = (classification: string): Expected => ({ classification, differingFields: [] });
  const key = `${l.success ? "success" : "revert"}/${p.success ? "success" : "revert"}`;
  switch (key) {
    case "revert/revert":
      return none(dataDiffers ? "reason-modernised" : "match");
    case "success/revert":
      return isPanic(p.data)
        ? none("exorcised")
        : { classification: "port-bug", differingFields: sorted(["success", ...(dataDiffers ? ["returnData"] : [])]) };
    case "revert/success":
      return { classification: "port-bug", differingFields: sorted(["success", ...(dataDiffers ? ["returnData"] : [])]) };
    default: {
      const fields = [
        ...(dataDiffers ? ["returnData"] : []),
        ...(sameLogs(l.logs, p.logs) ? [] : ["logs"]),
        ...differingStateKeys(l.state, p.state),
      ];
      return fields.length === 0 ? none("match") : { classification: "port-bug", differingFields: sorted(fields) };
    }
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const PANIC = "0x4e487b71" + "00".repeat(31) + "11";
const recase = (h: string): string => (h === "SELF" ? h : "0x" + h.slice(2).toUpperCase());
const hexOf = (bs: number[]): string => "0x" + bs.map((b) => b.toString(16).padStart(2, "0")).join("");

const hexArb = fc.oneof(
  fc.constantFrom("0x", "0x00", "0x01", "0xdeadbeef", "0xDEADBEEF"),
  fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 40 }).map(hexOf),
);
const panicArb = fc.constantFrom(
  PANIC,
  recase(PANIC),
  "0x4e487b72" + "00".repeat(31) + "11", // wrong selector
  "0x4e487b71" + "00".repeat(31) + "12", // wrong code
  "0x4e487b71" + "00".repeat(30) + "0111", // wrong code, high byte set
  PANIC + "00", // extra byte
  PANIC.slice(0, -2), // missing byte
  "0x4e487b71", // selector only
  "0x" + "00".repeat(31) + "11", // word only
  "0x08c379a0" + "00".repeat(31) + "11", // Error(string) selector
);
const dataArb = fc.oneof({ weight: 3, arbitrary: hexArb }, { weight: 2, arbitrary: panicArb });

const word = (b: number): string => "0x" + b.toString(16).padStart(2, "0").repeat(32);
const wordArb = fc.oneof(
  fc.constantFrom(0, 1, 2).map(word),
  fc.constantFrom(0, 1).map((n) => recase(word(n))),
  fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 32, maxLength: 32 }).map(hexOf),
);
const STATE_KEYS = ["returnData", "logs", "success", "allowed(0xA1,0xA2)", "balance", "totalSupply"] as const;
const stateKeyArb = fc.constantFrom(...STATE_KEYS);
const stateArb = fc.dictionary(stateKeyArb, wordArb, { maxKeys: 4 });

const ADDRS = ["0x" + "aa".repeat(20), "0x" + "bb".repeat(20), "0x" + "AA".repeat(20)];
const logArb: fc.Arbitrary<NormLog> = fc.record({
  emitter: fc.oneof(fc.constant("SELF"), fc.constantFrom(...ADDRS)),
  topics: fc.array(fc.constantFrom(0, 1, 2).map(word), { maxLength: 4 }),
  data: fc.constantFrom("0x", "0x01", "0x" + "00".repeat(32), "0x0A"),
});
const logsArb = fc.array(logArb, { maxLength: 4 });

const recordArb: fc.Arbitrary<CallRecord> = fc.record({
  success: fc.boolean(),
  data: dataArb,
  logs: logsArb,
  state: stateArb,
});

const deriveArb = fc.record({
  succSel: fc.constantFrom("same", "own"),
  dataSel: fc.constantFrom("same", "case", "own"),
  stateSel: fc.constantFrom("same", "case", "set", "remove", "own"),
  logsSel: fc.constantFrom("same", "case", "swap", "drop", "mutate", "own"),
  i: fc.nat(100),
  j: fc.nat(100),
  key: stateKeyArb,
  val: wordArb,
});

type Derive = typeof deriveArb extends fc.Arbitrary<infer T> ? T : never;

function derive(l: CallRecord, p: CallRecord, d: Derive): CallRecord {
  const state: Record<string, string> = { ...l.state };
  if (d.stateSel === "case") for (const k of Object.keys(state)) state[k] = recase(state[k]!);
  if (d.stateSel === "set") state[d.key] = d.val;
  if (d.stateSel === "remove") delete state[d.key];
  const logs: NormLog[] = l.logs.map((x) => ({ ...x, topics: [...x.topics] }));
  if (d.logsSel === "case") for (const x of logs) Object.assign(x, { emitter: recase(x.emitter), topics: x.topics.map(recase), data: recase(x.data) });
  if (d.logsSel === "swap" && logs.length > 1) {
    const a = d.i % logs.length;
    const b = d.j % logs.length;
    [logs[a], logs[b]] = [logs[b]!, logs[a]!];
  }
  if (d.logsSel === "drop" && logs.length > 0) logs.splice(d.i % logs.length, 1);
  if (d.logsSel === "mutate" && logs.length > 0) logs[d.i % logs.length]!.data += "00";
  return {
    success: d.succSel === "same" ? l.success : p.success,
    data: d.dataSel === "same" ? l.data : d.dataSel === "case" ? recase(l.data) : p.data,
    state: d.stateSel === "own" ? p.state : state,
    logs: d.logsSel === "own" ? p.logs : logs,
  };
}

/** Pairs of well-formed records, biased toward collisions between the two sides. */
const pairArb: fc.Arbitrary<[CallRecord, CallRecord]> = fc
  .tuple(recordArb, recordArb, deriveArb, fc.boolean())
  .map(([l, p, d, useDerived]) => [l, useDerived ? derive(l, p, d) : p]);

const badHexArb = fc.oneof(
  fc.constantFrom("00", "abcd", "0xabc", "0x0", "0Xab", "0xzz", "", " 0x00"),
  fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 8 }).map((bs) => hexOf(bs).slice(2)), // no prefix
  fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 8 }).map((bs) => hexOf(bs) + "f"), // odd digits
);
const malformedRecordArb = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.anything(),
  fc.tuple(recordArb, badHexArb).map(([r, bad]) => ({ ...r, data: bad })),
  fc.tuple(recordArb, badHexArb).map(([r, bad]) => ({ ...r, state: { ...r.state, balance: bad } })),
  fc.tuple(recordArb, badHexArb).map(([r, bad]) => ({ ...r, logs: [{ emitter: "SELF", topics: [bad], data: "0x" }] })),
  recordArb.map((r) => ({ ...r, success: "true" })),
);

const run = { numRuns: NUM_RUNS };

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("Property 8: classification follows the decision table", () => {
  it("(a) equals the oracle for valid pairs; the class is always one of the four, even for malformed input", () => {
    fc.assert(
      fc.property(pairArb, ([l, p]) => {
        const r = classify(l, p);
        const e = oracle(l, p);
        expect(r.classification).toBe(e.classification);
        expect(r.differingFields).toEqual(e.differingFields);
        expect(r.invalidRecord).toBe(false);
        expect(CLASSIFICATIONS).toContain(r.classification);
      }),
      run,
    );
    fc.assert(
      fc.property(fc.oneof(malformedRecordArb, recordArb), fc.oneof(malformedRecordArb, recordArb), (l, p) => {
        expect(CLASSIFICATIONS).toContain(classify(l, p).classification);
      }),
      run,
    );
  });

  it("(b) match, reason-modernised, exorcised and port-bug hold exactly under their stated conditions", () => {
    fc.assert(
      fc.property(pairArb, ([l, p]) => {
        const c = classify(l, p).classification;
        const bothOk = l.success && p.success;
        const bothRevert = !l.success && !p.success;
        const sameData = sameBytes(l.data, p.data);
        const allEqual = sameData && sameLogs(l.logs, p.logs) && differingStateKeys(l.state, p.state).length === 0;

        expect(c === "match").toBe((bothOk && allEqual) || (bothRevert && sameData));
        expect(c === "reason-modernised").toBe(bothRevert && !sameData);
        expect(c === "exorcised").toBe(l.success && !p.success && p.data.length === 74 && isPanic(p.data));
        const others = ["match", "reason-modernised", "exorcised"];
        expect(c === "port-bug").toBe(!others.includes(c));
      }),
      run,
    );
  });

  it("(c) one-sided port-bug cases are never exorcised, match or reason-modernised", () => {
    const nonPanicRevert = recordArb.filter((r) => !isPanic(r.data)).map((r) => ({ ...r, success: false }));
    const okRec = recordArb.map((r) => ({ ...r, success: true }));
    const revRec = recordArb.map((r) => ({ ...r, success: false }));
    fc.assert(
      fc.property(fc.oneof(fc.tuple(okRec, nonPanicRevert), fc.tuple(revRec, okRec)), ([l, p]) => {
        const r = classify(l, p);
        expect(r.classification).toBe("port-bug");
        expect(r.invalidRecord).toBe(false);
        expect(r.differingFields).toEqual(oracle(l, p).differingFields);
        expect(r.differingFields).toContain("success");
        expect(r.differingFields.includes("returnData")).toBe(!sameBytes(l.data, p.data));
      }),
      run,
    );
  });

  describe("(d) single state/log differences are port-bug; reverted state and logs are ignored", () => {
    const baseOk = fc.record({ data: dataArb, logs: logsArb, state: fc.dictionary(stateKeyArb, wordArb, { minKeys: 1, maxKeys: 4 }) });

    it("a single differing state value", () => {
      fc.assert(
        fc.property(baseOk, fc.nat(100), fc.integer({ min: 1, max: 255 }), (b, i, xor) => {
          const l: CallRecord = { success: true, ...b };
          const keys = Object.keys(b.state);
          const k = keys[i % keys.length]!;
          const raw = bytes(b.state[k]!);
          raw[raw.length - 1] = raw[raw.length - 1]! ^ xor;
          const p: CallRecord = { success: true, ...b, state: { ...b.state, [k]: "0x" + raw.toString("hex") } };
          const r = classify(l, p);
          expect(r.classification).toBe("port-bug");
          expect(r.differingFields).toEqual([`state.${k}`]);
          expect(r.differingFields).toEqual(oracle(l, p).differingFields);
        }),
        run,
      );
    });

    it("a single differing log: count, order, topics, data or emitter", () => {
      const kindArb = fc.constantFrom("append", "drop", "swap", "topic", "addTopic", "data", "emitter");
      fc.assert(
        fc.property(baseOk, kindArb, fc.nat(100), fc.nat(100), logArb, (b, kind, i, j, extra) => {
          const logs: NormLog[] = b.logs.map((x) => ({ ...x, topics: [...x.topics] }));
          if (kind === "append") logs.push(extra);
          else {
            fc.pre(logs.length > 0);
            const a = i % logs.length;
            const t = logs[a]!;
            if (kind === "drop") logs.splice(a, 1);
            if (kind === "swap") {
              const c = j % logs.length;
              fc.pre(logKey(logs[a]!) !== logKey(logs[c]!));
              [logs[a], logs[c]] = [logs[c]!, logs[a]!];
            }
            if (kind === "topic") {
              fc.pre(t.topics.length > 0);
              t.topics[0] = word(7);
            }
            if (kind === "addTopic") {
              fc.pre(t.topics.length < 4);
              t.topics.push(word(7));
            }
            if (kind === "data") t.data += "00";
            if (kind === "emitter") t.emitter = t.emitter === "SELF" ? ADDRS[1]! : "SELF";
          }
          fc.pre(!sameLogs(b.logs, logs));
          const l: CallRecord = { success: true, ...b };
          const p: CallRecord = { success: true, ...b, logs };
          const r = classify(l, p);
          expect(r.classification).toBe("port-bug");
          expect(r.differingFields).toEqual(["logs"]);
          expect(r.differingFields).toEqual(oracle(l, p).differingFields);
        }),
        run,
      );
    });

    it("state and logs of reverted records never influence the result", () => {
      fc.assert(
        fc.property(pairArb, logsArb, stateArb, logsArb, stateArb, ([l, p], lLogs, lState, pLogs, pState) => {
          const l2 = l.success ? l : { ...l, logs: lLogs, state: lState };
          const p2 = p.success ? p : { ...p, logs: pLogs, state: pState };
          expect(classify(l2, p2)).toEqual(classify(l, p));
        }),
        run,
      );
    });
  });

  describe("(e) differingFields shape", () => {
    it("is empty unless port-bug, non-empty for every valid port-bug, and empty when malformed", () => {
      fc.assert(
        fc.property(pairArb, ([l, p]) => {
          const r = classify(l, p);
          if (r.classification === "port-bug") expect(r.differingFields.length).toBeGreaterThan(0);
          else expect(r.differingFields).toEqual([]);
          expect(r.differingFields).toEqual([...new Set(r.differingFields)].sort());
          for (const f of r.differingFields) {
            expect(f === "success" || f === "returnData" || f === "logs" || f.startsWith("state.")).toBe(true);
          }
        }),
        run,
      );
      fc.assert(
        fc.property(malformedRecordArb, recordArb, fc.boolean(), (bad, good, badFirst) => {
          const r = badFirst ? classify(bad, good) : classify(good, bad);
          expect(r.classification).toBe("port-bug");
          expect(r.invalidRecord).toBe(true);
          expect(r.differingFields).toEqual([]);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it("prefixes every state key with 'state.', including keys named returnData, logs and success", () => {
      const special = fc.dictionary(fc.constantFrom("returnData", "logs", "success"), wordArb, { maxKeys: 3 });
      fc.assert(
        fc.property(special, special, dataArb, (ls, ps, data) => {
          const l: CallRecord = { success: true, data, logs: [], state: ls };
          const p: CallRecord = { success: true, data, logs: [], state: ps };
          const r = classify(l, p);
          const expected = differingStateKeys(ls, ps);
          expect(r.differingFields).toEqual(expected.sort());
          // Same data and logs on both sides, so a bare fixed name can never appear.
          for (const bare of ["returnData", "logs", "success"]) expect(r.differingFields).not.toContain(bare);
          expect(r.classification).toBe(expected.length === 0 ? "match" : "port-bug");
        }),
        run,
      );
    });
  });

  it("(f) logs that differ only in the deployment-address emitter classify as match after normalisation", () => {
    const addr = (b: number): string => "0x" + b.toString(16).padStart(2, "0").repeat(20);
    const template = fc.record({
      self: fc.boolean(),
      other: fc.constantFrom(addr(0xaa), addr(0xbb)),
      topics: fc.array(fc.constantFrom(0, 1, 2).map(word), { maxLength: 4 }),
      data: fc.constantFrom("0x", "0x01", "0x0A"),
      upper: fc.boolean(),
    });
    fc.assert(
      fc.property(
        fc.array(template, { maxLength: 4 }),
        fc.constantFrom(0xd1, 0xd2, 0xd3),
        fc.constantFrom(0xe1, 0xe2, 0xe3),
        stateArb,
        dataArb,
        (ts, lb, pb, state, data) => {
          const legacyAddr = addr(lb);
          const portAddr = addr(pb);
          const raw = (own: string): RawLog[] =>
            ts.map((t) => ({ emitter: t.self ? (t.upper ? recase(own) : own) : t.other, topics: t.topics, data: t.data }));
          const l: CallRecord = { success: true, data, state, logs: normalizeLogs(raw(legacyAddr), legacyAddr, true) };
          const p: CallRecord = { success: true, data, state, logs: normalizeLogs(raw(portAddr), portAddr, true) };
          const r = classify(l, p);
          expect(r.classification).toBe("match");
          expect(r.differingFields).toEqual([]);
        },
      ),
      run,
    );
  });

  it("agrees with the oracle on every 'both'-scope shared vector", () => {
    interface V {
      name: string;
      scope: string;
      legacy: CallRecord;
      port: CallRecord;
      expect: { classification: string; invalidRecord: boolean; differingFields: string[] };
    }
    const both = (vectors.vectors as unknown as V[]).filter((v) => v.scope === "both");
    expect(both.length).toBeGreaterThan(0);
    for (const v of both) {
      expect(v.expect.invalidRecord, v.name).toBe(false);
      expect(oracle(v.legacy, v.port), v.name).toEqual({
        classification: v.expect.classification,
        differingFields: v.expect.differingFields,
      });
    }
  });
});
