import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import autopsySchema from "../../src/seance/schemas/autopsy-v1.schema.json" with { type: "json" };
import reportSchema from "../../src/seance/schemas/seance-report.schema.json" with { type: "json" };
import type { AutopsyReport, Finding, SeanceReport } from "../../src/seance/types.js";

const schemaByName: Record<string, object> = {
  "autopsy-v1.schema.json": autopsySchema,
  "seance-report.schema.json": reportSchema,
};

const ajv = new Ajv2020.default({ allErrors: true, strict: true, strictRequired: true });
const validateAutopsy = ajv.compile(autopsySchema as object);
const validateReport = ajv.compile(reportSchema as object);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const A = "0x" + "11".repeat(20);

const autopsy: AutopsyReport = {
  schemaVersion: "1",
  contract: "BecToken",
  sites: [
    {
      id: "batchTransfer:cnt*_value",
      function: "batchTransfer",
      operator: "*",
      operands: [
        { kind: "arrayLength", name: "_receivers", type: "uint256" },
        { kind: "param", name: "_value", type: "uint256" },
      ],
      location: { file: "BecToken.sol", line: 257, column: 17 },
      precondition: [{ kind: "constructor-balance", hint: "owner holds supply" }],
    },
  ],
};

const base = {
  function: "batchTransfer",
  calldata: "0x83f12fec",
  sender: A,
  value: "0",
  precedingCalls: [],
};
const exorcised: Finding = {
  ...base,
  classification: "exorcised",
  originalLength: 7,
  site: { id: "batchTransfer:cnt*_value", location: { file: "BecToken.sol", line: 257, column: 17 } },
};
const wire = { success: true, data: "0x", logs: [], stateHash: "0x" + "ab".repeat(32) };
const portBug: Finding = {
  ...base,
  function: "transfer",
  classification: "port-bug",
  unshrunk: true,
  unshrunkReason: "setup",
  site: "unattributed",
  legacy: wire,
  port: { ...wire, stateFields: { balance: "0x01" } },
  differingFields: ["logs"],
};
const report: SeanceReport = {
  schemaVersion: "1",
  contract: "BecToken",
  seed: "0x1",
  runs: 256,
  depth: 64,
  totalCalls: 10,
  counts: { match: 5, "reason-modernised": 2, exorcised: 2, "port-bug": 1 },
  taintedCalls: 0,
  setupCalls: 1,
  exorcisms: [exorcised],
  portBugs: [portBug],
  sequenceResults: { total: 3, endedExorcised: 1, exorcisedAtIndex: [4] },
  shrinking: { witnessCap: 10, pairsFound: 2, pairsSetup: 1, pairsShrunk: 1, pairsUnshrunk: 0, pairsOverCap: 0, deadlineReached: false },
  unreachableSites: [],
};

describe("autopsy-v1 schema", () => {
  it("compiles and accepts a BEC-like report", () => {
    expect(validateAutopsy(autopsy)).toBe(true);
  });
  it("rejects missing schemaVersion", () => {
    const r: any = clone(autopsy);
    delete r.schemaVersion;
    expect(validateAutopsy(r)).toBe(false);
  });
  it("rejects wrong schemaVersion", () => {
    expect(validateAutopsy({ ...clone(autopsy), schemaVersion: "2" })).toBe(false);
  });
  it("rejects a bad operator", () => {
    const r: any = clone(autopsy);
    r.sites[0].operator = "/";
    expect(validateAutopsy(r)).toBe(false);
  });
  it("rejects a bad uint width", () => {
    const r: any = clone(autopsy);
    r.sites[0].operands[0].type = "uint7";
    expect(validateAutopsy(r)).toBe(false);
  });
  it("rejects an unknown operand kind and a wrong operand count", () => {
    const r: any = clone(autopsy);
    r.sites[0].operands[1] = { kind: "mystery", type: "uint256" };
    expect(validateAutopsy(r)).toBe(false);
    const s: any = clone(autopsy);
    s.sites[0].operands.pop();
    expect(validateAutopsy(s)).toBe(false);
  });
});

describe("schema ids", () => {
  const base = "https://github.com/CharlesChinedum/exhume/blob/main/engine/src/seance/schemas/";
  for (const name of ["autopsy-v1.schema.json", "seance-report.schema.json"]) {
    it(`${name} has the expected $id`, () => {
      const id = (schemaByName[name] as { $id: string }).$id;
      expect(id).toBe(base + name);
      expect(id.endsWith(name)).toBe(true);
    });
  }
});

describe("SourceLocation is 1-based", () => {
  it("autopsy rejects line 0 / column 0 and accepts 1:1", () => {
    for (const [line, column, ok] of [[0, 1, false], [1, 0, false], [1, 1, true]] as const) {
      const r: any = clone(autopsy);
      r.sites[0].location = { file: "BecToken.sol", line, column };
      expect(validateAutopsy(r)).toBe(ok);
    }
  });
  it("report finding site rejects line 0 / column 0 and accepts 1:1", () => {
    for (const [line, column, ok] of [[0, 1, false], [1, 0, false], [1, 1, true]] as const) {
      const r: any = clone(report);
      r.exorcisms[0].site = { id: "batchTransfer:cnt*_value", location: { file: "BecToken.sol", line, column } };
      expect(validateReport(r)).toBe(ok);
    }
  });
});

describe("seance-report schema", () => {
  it("compiles and accepts a report with a shrunk exorcism and an unshrunk setup port bug", () => {
    expect(validateReport(clone(report))).toBe(true);
  });
  it("accepts a typed SeanceReport after JSON serialization (types and schema in sync)", () => {
    expect(validateReport(JSON.parse(JSON.stringify(report)))).toBe(true);
  });
  const bad = (name: string, mutate: (r: any) => void) =>
    it(`rejects ${name}`, () => {
      const r: any = clone(report);
      mutate(r);
      expect(validateReport(r)).toBe(false);
    });
  bad("missing depth", (r) => delete r.depth);
  bad("counts missing a class", (r) => delete r.counts["port-bug"]);
  bad("shrinking missing a field", (r) => delete r.shrinking.pairsOverCap);
  bad("an extra shrinking field", (r) => (r.shrinking.extra = 1));
  bad("a wrong witnessCap", (r) => (r.shrinking.witnessCap = 11));
  bad("a negative count", (r) => (r.counts.match = -1));
  bad("unshrunk finding without unshrunkReason", (r) => delete r.portBugs[0].unshrunkReason);
  bad("shrunk finding with unshrunkReason", (r) => (r.exorcisms[0].unshrunkReason = "deadline"));
  bad("a finding with neither originalLength nor unshrunk", (r) => delete r.exorcisms[0].originalLength);
  bad("an unshrunk finding with originalLength", (r) => (r.portBugs[0].originalLength = 3));
  bad("port-bug finding without legacy", (r) => delete r.portBugs[0].legacy);
  bad("exorcised finding with legacy", (r) => (r.exorcisms[0].legacy = wire));
  bad("an unknown unshrunkReason", (r) => (r.portBugs[0].unshrunkReason = "gave-up"));
  bad("a bad sender address", (r) => (r.exorcisms[0].sender = "0x1234"));
  bad("non-decimal msg.value", (r) => (r.exorcisms[0].value = "0x10"));
});
