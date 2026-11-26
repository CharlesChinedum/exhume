/**
 * Task 10.4: run orchestration. Two halves:
 *  - a scripted `ProcessRunner` (no forge) that checks order, early failures, deadlines, dispositions,
 *    environment, seed pass-through and the temp-directory lifecycle;
 *  - the real runner and real forge on the token fixture (skipped without forge, forge-std or solc).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listInstalledSolc, readLegacyArtifact } from "../../src/seance/bytecode.js";
import { loadAbi } from "../../src/seance/abi.js";
import { INVARIANT_RUNS } from "../../src/seance/forge-std-pin.js";
import {
  generateSrcProject,
  planHandlerFunctions,
  writeProjectFiles,
} from "../../src/seance/project-generator.js";
import { parseReport, validateReport } from "../../src/seance/report.js";
import {
  createProcessRunner,
  failingFilesFromOutput,
  parseForgeJson,
  partialCountsFromJsonl,
  runSeance,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
  type RunnerDeps,
} from "../../src/seance/runner.js";
import type { Classification, RecordLine, SeanceError, SeanceInput } from "../../src/seance/types.js";
import { DOCKER_TOKEN, FORGE_TIMEOUT, LOCAL_STD, skipReason } from "./template-project.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LEGACY_SRC = readFileSync(join(DOCKER_TOKEN, "src/legacy/LegacyToken.sol"), "utf8");
const PORT_SRC = readFileSync(join(DOCKER_TOKEN, "src/port/PortToken.sol"), "utf8");
const FAKE_CODE = "0x608060405234801561001057600080fd5b50";

/** Hand-written autopsy for the token's `cnt * _value` (BEC-like). */
const AUTOPSY = JSON.stringify({
  schemaVersion: "1",
  contract: "Token",
  sites: [
    {
      id: "batchTransfer:cnt*_value",
      function: "batchTransfer",
      operator: "*",
      operands: [
        { kind: "arrayLength", name: "_receivers", type: "uint256" },
        { kind: "param", name: "_value", type: "uint256" },
      ],
      location: { file: "LegacyToken.sol", line: 21, column: 27 },
      precondition: [{ kind: "constructor-balance", hint: "deployer holds the supply" }],
    },
  ],
});
const EMPTY_AUTOPSY = JSON.stringify({ schemaVersion: "1", contract: "Token", sites: [] });

function input(over: Record<string, unknown> = {}): SeanceInput {
  return {
    contractName: "Token",
    legacySource: LEGACY_SRC,
    portSource: PORT_SRC,
    autopsyReport: EMPTY_AUTOPSY,
    legacySolcVersion: "0.4.19",
    legacyOptimizer: false,
    onChainRuntimeCode: FAKE_CODE,
    fuzzSeed: "42",
    ...over,
  } as SeanceInput;
}

const fnAbi = (name: string, params: [string, string][], mut = "nonpayable") => ({
  type: "function",
  name,
  inputs: params.map(([n, t]) => ({ name: n, type: t })),
  outputs: [],
  stateMutability: mut,
});
const TOKEN_ABI_JSON = [
  { type: "constructor", inputs: [], stateMutability: "nonpayable" },
  fnAbi("balanceOf", [["_owner", "address"]], "view"),
  fnAbi("transfer", [
    ["_to", "address"],
    ["_value", "uint256"],
  ]),
  fnAbi("batchTransfer", [
    ["_receivers", "address[]"],
    ["_value", "uint256"],
  ]),
];
const manyAbiJson = (n: number) => [
  { type: "constructor", inputs: [], stateMutability: "nonpayable" },
  ...Array.from({ length: n }, (_, i) => fnAbi(`f${i + 1}`, [["x", "uint256"]])),
];

// ---------------------------------------------------------------------------
// Record and forge JSON builders
// ---------------------------------------------------------------------------

const SENDER = "0x" + "11".repeat(20);
const CALLDATA = "0x12345678" + "00".repeat(32);
const wire = (success: boolean) => ({ success, data: "0x", logs: [], stateHash: "0x" + "00".repeat(32) });

function rec(
  idx: number,
  fn: string,
  classification: Classification,
  extra: { afterDivergence?: boolean; calldata?: string } = {},
): RecordLine {
  return {
    idx,
    function: fn,
    selector: "0x12345678",
    calldata: extra.calldata ?? CALLDATA,
    sender: SENDER,
    value: "0",
    legacy: wire(true),
    port: wire(classification !== "exorcised" && classification !== "reason-modernised"),
    classification,
    differingFields: classification === "port-bug" ? ["success"] : [],
    invalidRecord: false,
    afterDivergence: extra.afterDivergence ?? false,
  };
}
const jsonl = (recs: RecordLine[]): string => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";

const statusJson = (contract: string, test: string, status: "Success" | "Failure", reason: string | null = null): string =>
  JSON.stringify({
    [`test/X.t.sol:${contract}`]: {
      test_results: {
        [`${test}()`]: {
          status,
          reason,
          counterexample: null,
          kind: { Invariant: { runs: 256, calls: 16384, reverts: status === "Failure" ? 1 : 0 } },
        },
      },
    },
  });
const witnessJson = (k: number, calls: { func_name: string; calldata: string }[] | undefined): string =>
  calls === undefined
    ? statusJson(`Witness${k}`, "invariant_witness", "Success")
    : JSON.stringify({
        [`test/Witness.t.sol:Witness${k}`]: {
          test_results: {
            "invariant_witness()": {
              status: "Failure",
              reason: "witness hit",
              counterexample: { Sequence: [calls.length + 7, calls.map((c) => ({ ...c, sender: SENDER }))] },
              kind: { Invariant: { runs: 0, calls: 0, reverts: 0 } },
            },
          },
        },
      });

/** Handler calldata (selector + zero words) for `handler_<fn>` of the given ABI. */
function handlerCalldata(abiJson: unknown, fn: string): string {
  const abi = loadAbi(abiJson);
  if (!abi.ok) throw new Error(abi.error.message);
  const hs = planHandlerFunctions(abi.value);
  if (!hs.ok) throw new Error(hs.error.message);
  const h = hs.value.find((x) => x.recordName === fn);
  if (!h) throw new Error(`no handler for ${fn}`);
  return h.selector + "00".repeat(32 * h.paramTypes.length);
}

// ---------------------------------------------------------------------------
// The scripted runner
// ---------------------------------------------------------------------------

type PhaseName = "build" | "discovery" | "witness" | "replay";
interface Logged {
  phase: PhaseName;
  k?: number;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Test files as they were when forge was launched. */
  witnessSol: string;
  replaySol: string;
  testFiles: string[];
  hasTestDir: boolean;
  cacheInvariant: boolean;
}
type Res = Partial<ProcessResult>;
interface Script {
  build?: (c: Logged) => Res;
  discovery?: (c: Logged) => Res;
  witness?: (c: Logged, k: number) => Res;
  replay?: (c: Logged, k: number) => Res;
}

function phaseOf(args: string[]): { phase: PhaseName; k?: number } {
  if (args[0] === "build") return { phase: "build" };
  const mc = args[args.indexOf("--match-contract") + 1] ?? "";
  if (mc === "^SeanceDiscovery$") return { phase: "discovery" };
  let m = /^\^Witness(\d+)\$$/.exec(mc);
  if (m) return { phase: "witness", k: Number(m[1]) };
  m = /^\^SeanceReplay(\d+)\$$/.exec(mc);
  if (m) return { phase: "replay", k: Number(m[1]) };
  throw new Error(`unexpected forge args ${args.join(" ")}`);
}
const readIf = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");

class FakeRunner implements ProcessRunner {
  log: Logged[] = [];
  constructor(public script: Script) {}
  run(cmd: string, args: string[], opts: ProcessRunOptions): Promise<ProcessResult> {
    if (cmd !== "forge") throw new Error(`unexpected command ${cmd}`);
    const { phase, k } = phaseOf(args);
    const c: Logged = {
      phase,
      ...(k !== undefined && { k }),
      args,
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      witnessSol: readIf(join(opts.cwd, "test/Witness.t.sol")),
      replaySol: readIf(join(opts.cwd, "test/Replay.t.sol")),
      testFiles: existsSync(join(opts.cwd, "test")) ? readdirSync(join(opts.cwd, "test")).sort() : [],
      hasTestDir: existsSync(join(opts.cwd, "test")),
      cacheInvariant: existsSync(join(opts.cwd, "cache/invariant")),
    };
    this.log.push(c);
    const h = this.script[phase] as ((c: Logged, k?: number) => Res) | undefined;
    if (!h) throw new Error(`no script for phase ${phase}`);
    const r = h(c, k);
    return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false, ...r });
  }
  phases(): string[] {
    return this.log.map((c) => (c.k !== undefined ? `${c.phase}${c.k}` : c.phase));
  }
}

function put(cwd: string, rel: string, text: string): void {
  const p = join(cwd, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

interface Cfg {
  abiJson?: unknown[];
  portAbiJson?: unknown[];
  legacyCode?: string;
  /** Pairs in selection order: pair k-1 is witness k. */
  pairs?: { fn: string; cls: "exorcised" | "port-bug" }[];
  discoveryRecords?: RecordLine[];
  /** Witness result per k; `undefined` entry means the campaign passed. Default: failed with one call. */
  witnessFails?: (k: number) => boolean;
  /** Replay records per k; default: one record confirming the pair. */
  replayRecords?: (k: number, pair: { fn: string; cls: "exorcised" | "port-bug" }) => RecordLine[];
}

const DEFAULT_PAIRS: { fn: string; cls: "exorcised" | "port-bug" }[] = [
  { fn: "batchTransfer", cls: "exorcised" },
  { fn: "transfer", cls: "port-bug" },
];

/** Discovery records that yield exactly `pairs`, each in its own sequence (exorcised ends its sequence). */
function recordsFor(pairs: { fn: string; cls: "exorcised" | "port-bug" }[]): RecordLine[] {
  const out: RecordLine[] = [];
  for (const p of pairs) {
    out.push(rec(0, "balanceOf", "match"));
    out.push(rec(1, p.fn, p.cls));
  }
  return out;
}

function happy(cfg: Cfg = {}): Script {
  const abiJson = cfg.abiJson ?? TOKEN_ABI_JSON;
  const pairs = cfg.pairs ?? DEFAULT_PAIRS;
  const witnessFails = cfg.witnessFails ?? (() => true);
  return {
    build: (c) => {
      put(
        c.cwd,
        "out/LegacyToken.sol/Token.json",
        JSON.stringify({ abi: abiJson, deployedBytecode: { object: cfg.legacyCode ?? FAKE_CODE } }),
      );
      put(c.cwd, "out/PortToken.sol/Token.json", JSON.stringify({ abi: cfg.portAbiJson ?? abiJson, deployedBytecode: { object: "0x6001" } }));
      return {};
    },
    discovery: (c) => {
      put(c.cwd, "seance-out/records.jsonl", jsonl(cfg.discoveryRecords ?? recordsFor(pairs)));
      return { stdout: statusJson("SeanceDiscovery", "invariant_discovery", "Success") };
    },
    witness: (_c, k) => {
      const p = pairs[k - 1]!;
      return {
        stdout: witnessFails(k)
          ? witnessJson(k, [{ func_name: `handler_${p.fn}`, calldata: handlerCalldata(abiJson, p.fn) }])
          : witnessJson(k, undefined),
      };
    },
    replay: (c, k) => {
      const p = pairs[k - 1]!;
      const recs = cfg.replayRecords ? cfg.replayRecords(k, p) : [rec(0, p.fn, p.cls)];
      put(c.cwd, `seance-out/replay-${k}.jsonl`, jsonl(recs));
      return {};
    },
  };
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});
const mk = (): string => {
  const d = mkdtempSync(join(tmpdir(), "exhume-run-"));
  cleanup.push(d);
  return d;
};

interface World {
  tmp: string;
  grave: string;
  clock: { t: number };
  runner: FakeRunner;
  deps: RunnerDeps;
}
function world(script: Script, over: Partial<RunnerDeps> = {}): World {
  const tmp = mk();
  const grave = mk();
  const clock = { t: 0 };
  const runner = new FakeRunner(script);
  const deps: RunnerDeps = {
    runner,
    now: () => clock.t,
    tmpRoot: tmp,
    solcInstalled: ["0.4.19", "0.8.28"],
    forgeStdDir: "/opt/forge-std",
    graveyardRoot: grave,
    ...over,
  };
  return { tmp, grave, clock, runner, deps };
}
const tempDirs = (w: World): string[] => readdirSync(w.tmp).filter((d) => d.startsWith("exhume-seance-"));
const DEADLINE_PASSED = 10_000_000; // ms, beyond the default 300 s

async function runOk(w: World, over: Record<string, unknown> = {}) {
  const r = await runSeance(input(over), w.deps);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
async function runErr(w: World, over: Record<string, unknown> = {}): Promise<SeanceError> {
  const r = await runSeance(input(over), w.deps);
  if (r.ok) throw new Error("expected an error");
  return r.error;
}
const finding = (rep: { exorcisms: any[]; portBugs: any[] }, fn: string): any =>
  [...rep.exorcisms, ...rep.portBugs].find((f) => f.function === fn);

// ---------------------------------------------------------------------------
// Early failures: nothing later runs
// ---------------------------------------------------------------------------

describe("early failures stop the run", () => {
  it("MISSING_INPUT and INVALID_INPUT: no forge call, no directory", async () => {
    const w = world(happy());
    const m = await runSeance({ contractName: "Token" }, w.deps);
    expect(!m.ok && m.error.code).toBe("MISSING_INPUT");
    const bad = await runSeance(input({ legacySolcVersion: "0.8.19" }), w.deps);
    expect(!bad.ok && bad.error.code).toBe("INVALID_INPUT");
    expect(w.runner.log).toEqual([]);
    expect(readdirSync(w.tmp)).toEqual([]);
  });

  it("SOLC_MISSING: no forge call at all, nothing written", async () => {
    const w = world(happy(), { solcInstalled: ["0.4.26"] });
    const e = await runErr(w);
    expect(e.code).toBe("SOLC_MISSING");
    expect(e.message).toContain("0.4.19");
    expect(w.runner.log).toEqual([]);
    expect(readdirSync(w.tmp)).toEqual([]);
  });

  it("BUILD_FAILED: full output, failing files named, project kept, nothing else runs", async () => {
    const output = "Error: Compiler run failed:\nError (7576): Undeclared identifier.\n --> src/port/PortToken.sol:12:9:\nsrc/legacy/LegacyToken.sol:5:3: Error: bad\n";
    const w = world({ build: () => ({ code: 1, stderr: output }) });
    const e = await runErr(w);
    expect(e.code).toBe("BUILD_FAILED");
    expect(e.message).toContain(output.trim());
    const d = e.details as { files: string[]; output: string; tempDir: string };
    expect(d.files).toEqual(["src/port/PortToken.sol", "src/legacy/LegacyToken.sol"]);
    expect(d.output).toContain("Undeclared identifier");
    expect(w.runner.phases()).toEqual(["build"]);
    expect(tempDirs(w)).toHaveLength(1);
    expect(existsSync(d.tempDir)).toBe(true);
    expect(existsSync(join(d.tempDir, "src/port/PortToken.sol"))).toBe(true);
    expect(existsSync(join(d.tempDir, "test"))).toBe(false); // no test/ file before the build passed
  });

  it("BYTECODE_MISMATCH: both hashes reported, no test generation, no discovery", async () => {
    const w = world(happy({ legacyCode: "0x6080604052deadbeef" }));
    const e = await runErr(w);
    expect(e.code).toBe("BYTECODE_MISMATCH");
    const d = e.details as { compiled: { hash: string }; onChain: { hash: string } };
    expect(d.compiled.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(d.onChain.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(d.compiled.hash).not.toBe(d.onChain.hash);
    expect(e.message).toContain(d.compiled.hash);
    expect(e.message).toContain(d.onChain.hash);
    expect(w.runner.phases()).toEqual(["build"]);
    expect(existsSync(join(tempDirs(w).map((t) => join(w.tmp, t))[0]!, "test"))).toBe(false);
  });

  it("port ABI mismatch: INVALID_INPUT naming the function, nothing fuzzed", async () => {
    const w = world(happy({ portAbiJson: TOKEN_ABI_JSON.filter((e) => (e as { name?: string }).name !== "transfer") }));
    const e = await runErr(w);
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.message).toContain("transfer(address,uint256)");
    expect(w.runner.phases()).toEqual(["build"]);
    expect(existsSync(join(w.tmp, tempDirs(w)[0]!, "test"))).toBe(false);
  });

  it("AUTOPSY_REJECTED (unknown function): after the build, before any test/ file or discovery", async () => {
    const bad = JSON.stringify({
      schemaVersion: "1",
      contract: "Token",
      sites: [
        {
          id: "s",
          function: "nope",
          operator: "+",
          operands: [
            { kind: "unknown", type: "uint256" },
            { kind: "unknown", type: "uint256" },
          ],
          location: { file: "x.sol", line: 1, column: 1 },
        },
      ],
    });
    const w = world(happy());
    const e = await runErr(w, { autopsyReport: bad });
    expect(e.code).toBe("AUTOPSY_REJECTED");
    expect(e.message).toContain("nope");
    expect(w.runner.phases()).toEqual(["build"]);
    expect(existsSync(join(w.tmp, tempDirs(w)[0]!, "test"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Discovery failures
// ---------------------------------------------------------------------------

describe("discovery failures", () => {
  it("HANDLER_FAULT: failed invariant, partial counts minus the last sequence, no report", async () => {
    const recs = [
      rec(-1, "transfer", "match"),
      rec(0, "balanceOf", "match"),
      rec(1, "transfer", "reason-modernised"),
      rec(0, "balanceOf", "match"),
      rec(1, "balanceOf", "exorcised"), // in-progress sequence: must not be counted
    ];
    const s = happy();
    s.discovery = (c) => {
      put(c.cwd, "seance-out/records.jsonl", jsonl(recs));
      return { code: 1, stdout: statusJson("SeanceDiscovery", "invariant_discovery", "Failure", "handler reverted") };
    };
    const w = world(s);
    const e = await runErr(w);
    expect(e.code).toBe("HANDLER_FAULT");
    expect(e.partialCounts).toEqual({ match: 2, "reason-modernised": 1, exorcised: 0, "port-bug": 0 });
    expect(w.runner.phases()).toEqual(["build", "discovery"]);
    expect(readdirSync(w.grave)).toEqual([]);
    expect(tempDirs(w)).toHaveLength(1);
  });

  it("test compilation failure in discovery is BUILD_FAILED with the output", async () => {
    const s = happy();
    s.discovery = () => ({ code: 1, stderr: "Error: Compiler run failed:\nStack too deep\n --> test/handler/DifferentialHandler.sol:40:5:\n" });
    const e = await runErr(world(s));
    expect(e.code).toBe("BUILD_FAILED");
    expect((e.details as { files: string[] }).files).toEqual(["test/handler/DifferentialHandler.sol"]);
  });

  it("TIMEOUT in build: phase build, no partialCounts, no report, discovery never launched", async () => {
    const w = world({ build: () => ({ timedOut: true, code: null }) });
    w.runner.script.build = () => {
      w.clock.t = DEADLINE_PASSED;
      return { timedOut: true, code: null };
    };
    const e = await runErr(w);
    expect(e.code).toBe("TIMEOUT");
    expect(e.phase).toBe("build");
    expect("partialCounts" in e).toBe(false);
    expect(w.runner.phases()).toEqual(["build"]);
    expect(readdirSync(w.grave)).toEqual([]);
    expect(tempDirs(w)).toHaveLength(1); // kept
  });

  it("a zero budget before forge build launches no process", async () => {
    const w = world(happy());
    let n = 0;
    w.deps.now = () => (n++ === 0 ? 0 : DEADLINE_PASSED);
    const e = await runErr(w);
    expect(e.code).toBe("TIMEOUT");
    expect(e.phase).toBe("build");
    expect(w.runner.log).toEqual([]);
  });

  it("TIMEOUT in discovery: phase discovery, partial counts from the complete lines, no report", async () => {
    const complete = [rec(-1, "transfer", "match"), rec(0, "balanceOf", "match"), rec(1, "transfer", "exorcised")];
    const w = world(happy());
    w.runner.script.discovery = (c) => {
      // the last line is cut off mid-record
      put(c.cwd, "seance-out/records.jsonl", jsonl(complete) + JSON.stringify(rec(0, "balanceOf", "port-bug")).slice(0, 40));
      w.clock.t = DEADLINE_PASSED;
      return { timedOut: true, code: null };
    };
    const e = await runErr(w);
    expect(e.code).toBe("TIMEOUT");
    expect(e.phase).toBe("discovery");
    expect(e.partialCounts).toEqual({ match: 2, "reason-modernised": 0, exorcised: 1, "port-bug": 0 });
    expect(w.runner.phases()).toEqual(["build", "discovery"]);
    expect(readdirSync(w.grave)).toEqual([]);
    expect(tempDirs(w)).toHaveLength(1);
  });

  it("a build that uses most of the budget leaves discovery only the remainder", async () => {
    const w = world(happy());
    const s = happy();
    const b = s.build!;
    w.runner.script.build = (c) => {
      w.clock.t = 250_000;
      return b(c);
    };
    await runOk(w);
    const [build, disc] = w.runner.log;
    expect(build!.timeoutMs).toBe(300_000);
    expect(disc!.timeoutMs).toBe(50_000);
  });
});

// ---------------------------------------------------------------------------
// Happy path with the scripted runner
// ---------------------------------------------------------------------------

describe("full run with a scripted forge", () => {
  it("runs build, discovery, witness 1..n, replay 1..n in order and writes a valid report", async () => {
    const w = world(happy());
    const r = await runOk(w);
    expect(w.runner.phases()).toEqual(["build", "discovery", "witness1", "witness2", "replay1", "replay2"]);
    expect(r.reportPath).toBe(join(w.grave, "Token", "seance-report.json"));
    const onDisk = parseReport(readFileSync(r.reportPath!, "utf8"));
    expect(onDisk.ok && onDisk.value).toEqual(r.report);
    expect(validateReport(r.report).ok).toBe(true);
    expect(r.report.shrinking).toMatchObject({ pairsFound: 2, pairsShrunk: 2, pairsUnshrunk: 0, deadlineReached: false });
    expect(finding(r.report, "batchTransfer")).toMatchObject({ classification: "exorcised", originalLength: 8 });
    expect(finding(r.report, "batchTransfer").unshrunk).toBeUndefined();
    expect(finding(r.report, "transfer")).toMatchObject({ classification: "port-bug", originalLength: 8 });
    expect(r.tempDir).toBeUndefined();
  });

  it("without a graveyard root the report is returned and nothing is written", async () => {
    const w = world(happy());
    delete w.deps.graveyardRoot;
    const r = await runOk(w);
    expect(r.reportPath).toBeUndefined();
    expect(r.report.contract).toBe("Token");
    expect(readdirSync(w.grave)).toEqual([]);
  });

  it("passes the seed unchanged to every test invocation, and records it", async () => {
    const w = world(happy());
    const r = await runOk(w, { fuzzSeed: "0xDEADbeef" });
    const tests = w.runner.log.filter((c) => c.phase !== "build");
    expect(tests).toHaveLength(5);
    for (const c of tests) {
      const i = c.args.indexOf("--fuzz-seed");
      expect(c.args[i + 1]).toBe("0xDEADbeef");
    }
    expect(w.runner.log[0]!.args).not.toContain("--fuzz-seed");
    expect(r.report.seed).toBe("0xDEADbeef");
  });

  it("without a seed no --fuzz-seed is passed and the report seed is empty", async () => {
    const w = world(happy());
    const i = input();
    delete (i as { fuzzSeed?: string }).fuzzSeed;
    const r = await runSeance(i, w.deps);
    expect(r.ok && r.value.report.seed).toBe("");
    expect(w.runner.log.every((c) => !c.args.includes("--fuzz-seed"))).toBe(true);
  });

  it("sets SEANCE_RECORD per phase, shrink limit only for witness, cwd is the temp project", async () => {
    const w = world(happy());
    const r = await runOk(w);
    expect(r.report.shrinking.pairsShrunk).toBe(2);
    const by = (p: string) => w.runner.log.filter((c) => c.phase === p);
    expect(by("build")[0]!.env).toEqual({});
    expect(by("discovery")[0]!.env).toEqual({ SEANCE_RECORD: "1" });
    for (const c of by("witness")) {
      expect(c.env["SEANCE_RECORD"]).toBe("0");
      expect(c.env["FOUNDRY_INVARIANT_SHRINK_RUN_LIMIT"]).toBe("5000");
    }
    for (const c of by("replay")) expect(c.env).toEqual({ SEANCE_RECORD: "1" });
    expect(new Set(w.runner.log.map((c) => c.cwd)).size).toBe(1);
    expect(w.runner.log[0]!.cwd.startsWith(w.tmp)).toBe(true);
    expect(by("witness").map((c) => c.args[c.args.indexOf("--match-contract") + 1])).toEqual(["^Witness1$", "^Witness2$"]);
  });

  it("writes test/ only after the build, Witness.t.sol only after discovery, Replay.t.sol only after the witnesses", async () => {
    const w = world(happy());
    await runOk(w);
    const [build, disc, w1, w2, r1] = w.runner.log;
    expect(build!.hasTestDir).toBe(false);
    expect(disc!.testFiles).toEqual(["Replay.t.sol", "Seance.t.sol", "Witness.t.sol", "handler"]);
    expect(disc!.witnessSol).not.toContain('"batchTransfer"'); // the discovery-time file knows no pair
    expect(w1!.witnessSol).not.toBe(disc!.witnessSol);
    expect(w1!.witnessSol).toContain('"batchTransfer"');
    expect(w1!.witnessSol).toContain('"transfer"');
    expect(w2!.witnessSol).toBe(w1!.witnessSol);
    expect(disc!.replaySol).toBe(w1!.replaySol); // not regenerated until the witnesses are done
    expect(r1!.replaySol).not.toBe(w2!.replaySol);
    expect(r1!.replaySol).toContain("handler.handler_batchTransfer(");
  });

  it("never starts forge in a directory that holds cache/invariant, and two runs use two directories", async () => {
    const w = world(happy(), { keepTempOnSuccess: true });
    const a = await runOk(w);
    const b = await runOk(w);
    expect(a.tempDir).toBeDefined();
    expect(b.tempDir).toBeDefined();
    expect(a.tempDir).not.toBe(b.tempDir);
    expect(w.runner.log.every((c) => !c.cacheInvariant)).toBe(true);
    const dirs = new Set(w.runner.log.map((c) => c.cwd));
    expect(dirs.size).toBe(2);
  });

  it("temp dir lifecycle: removed on success, kept on failure, removable with keepTempOnFailure false", async () => {
    const ok1 = world(happy());
    await runOk(ok1);
    expect(tempDirs(ok1)).toEqual([]);

    const f1 = world({ build: () => ({ code: 1, stderr: "boom" }) });
    await runErr(f1);
    expect(tempDirs(f1)).toHaveLength(1);

    const f2 = world({ build: () => ({ code: 1, stderr: "boom" }) }, { keepTempOnFailure: false });
    await runErr(f2);
    expect(tempDirs(f2)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dispositions
// ---------------------------------------------------------------------------

describe("pair outcomes", () => {
  it("setup findings are reported as-is and skip phases 2 and 3", async () => {
    const recs = [
      rec(-1, "transfer", "port-bug"),
      rec(0, "balanceOf", "match", { afterDivergence: true }),
      rec(1, "batchTransfer", "exorcised", { afterDivergence: true }),
    ];
    const w = world(happy({ discoveryRecords: recs }));
    const r = await runOk(w);
    expect(w.runner.phases()).toEqual(["build", "discovery"]);
    expect(r.report.shrinking).toMatchObject({ pairsSetup: 1, pairsFound: 1, pairsShrunk: 0 });
    expect(r.report.portBugs[0]).toMatchObject({ function: "transfer", unshrunk: true, unshrunkReason: "setup" });
    expect(r.report.exorcisms).toEqual([]); // tainted: never a finding
    expect(validateReport(r.report).ok).toBe(true);
  });

  it("no finding pairs: only build and discovery run", async () => {
    const w = world(happy({ discoveryRecords: [rec(0, "balanceOf", "match")] }));
    const r = await runOk(w);
    expect(w.runner.phases()).toEqual(["build", "discovery"]);
    expect(r.report.counts.match).toBe(1);
    expect(r.report.shrinking.pairsFound).toBe(0);
  });

  it("over-cap pairs: 12 fuzz pairs give 10 shrunk and 2 witness-cap, with 10 witness and 10 replay runs", async () => {
    const abiJson = manyAbiJson(12);
    const pairs = Array.from({ length: 12 }, (_, i) => ({ fn: `f${i + 1}`, cls: "exorcised" as const }));
    const w = world(happy({ abiJson, pairs }));
    const r = await runOk(w);
    expect(w.runner.log.filter((c) => c.phase === "witness").map((c) => c.k)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(w.runner.log.filter((c) => c.phase === "replay")).toHaveLength(10);
    expect(r.report.shrinking).toMatchObject({ pairsFound: 12, pairsShrunk: 10, pairsOverCap: 2, pairsUnshrunk: 0 });
    const capped = r.report.exorcisms.filter((f) => f.unshrunk === true);
    expect(capped.map((f) => [f.function, f.unshrunkReason])).toEqual([
      ["f11", "witness-cap"],
      ["f12", "witness-cap"],
    ]);
  });

  it("witness-not-failed: reported unshrunk with its original sequence, no replay for it", async () => {
    const w = world(happy({ witnessFails: (k) => k !== 1 }));
    const r = await runOk(w);
    expect(w.runner.phases()).toEqual(["build", "discovery", "witness1", "witness2", "replay2"]);
    expect(finding(r.report, "batchTransfer")).toMatchObject({ unshrunk: true, unshrunkReason: "witness-not-failed" });
    expect(finding(r.report, "transfer").unshrunk).toBeUndefined();
    expect(r.report.shrinking).toMatchObject({ pairsShrunk: 1, pairsUnshrunk: 1 });
  });

  it("replay-mismatch: the replay classification differs, the original is reported unshrunk", async () => {
    const w = world(happy({ replayRecords: (k, p) => [rec(0, p.fn, k === 1 ? "match" : p.cls)] }));
    const r = await runOk(w);
    expect(finding(r.report, "batchTransfer")).toMatchObject({ unshrunk: true, unshrunkReason: "replay-mismatch" });
    expect(finding(r.report, "transfer").unshrunk).toBeUndefined();
  });

  it("a replay with no record of the function is a replay-mismatch", async () => {
    const w = world(happy({ replayRecords: () => [rec(0, "balanceOf", "match")] }));
    const r = await runOk(w);
    expect(r.report.shrinking).toMatchObject({ pairsShrunk: 0, pairsUnshrunk: 2 });
    expect(finding(r.report, "transfer")).toMatchObject({ unshrunkReason: "replay-mismatch" });
  });

  it("the confirmed finding is built from the replay records, with the earlier replay calls as preceding calls", async () => {
    const pre = rec(0, "balanceOf", "match", { calldata: "0xaaaaaaaa" });
    const hit = rec(1, "batchTransfer", "exorcised", { calldata: "0xbbbbbbbb" });
    const w = world(happy({ pairs: [DEFAULT_PAIRS[0]!], replayRecords: () => [rec(-1, "transfer", "match"), pre, hit] }));
    const r = await runOk(w);
    const f = finding(r.report, "batchTransfer");
    expect(f.calldata).toBe("0xbbbbbbbb");
    expect(f.precedingCalls).toEqual([{ function: "balanceOf", calldata: "0xaaaaaaaa", sender: SENDER, value: "0" }]);
    expect(f.originalLength).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Deadline in witness / replay
// ---------------------------------------------------------------------------

describe("deadline during witness and replay never fails the run", () => {
  const THREE = [
    { fn: "f1", cls: "exorcised" as const },
    { fn: "f2", cls: "port-bug" as const },
    { fn: "f3", cls: "port-bug" as const },
  ];
  const ABI3 = manyAbiJson(3);

  it("witness timeout: every selected pair deadline, report written, ok, later runs not launched", async () => {
    const w = world(happy({ abiJson: ABI3, pairs: THREE }));
    const s = w.runner.script;
    const wit = s.witness!;
    s.witness = (c, k) => {
      if (k === 2) {
        w.clock.t = DEADLINE_PASSED;
        return { timedOut: true, code: null };
      }
      return wit(c, k);
    };
    const r = await runOk(w);
    expect(w.runner.phases()).toEqual(["build", "discovery", "witness1", "witness2"]);
    expect(r.report.shrinking).toMatchObject({ deadlineReached: true, pairsFound: 3, pairsUnshrunk: 3, pairsShrunk: 0 });
    for (const fn of ["f1", "f2", "f3"]) {
      expect(finding(r.report, fn)).toMatchObject({ unshrunk: true, unshrunkReason: "deadline" });
    }
    expect(existsSync(r.reportPath!)).toBe(true);
    expect(w.runner.log.at(-1)!.timeoutMs).toBeGreaterThan(0);
  });

  it("a pair whose witness passed before the deadline keeps witness-not-failed", async () => {
    const w = world(happy({ abiJson: ABI3, pairs: THREE, witnessFails: (k) => k !== 1 }));
    const wit = w.runner.script.witness!;
    w.runner.script.witness = (c, k) => {
      if (k === 2) {
        w.clock.t = DEADLINE_PASSED;
        return { timedOut: true, code: null };
      }
      return wit(c, k);
    };
    const r = await runOk(w);
    expect(finding(r.report, "f1")).toMatchObject({ unshrunkReason: "witness-not-failed" });
    expect(finding(r.report, "f2")).toMatchObject({ unshrunkReason: "deadline" });
    expect(finding(r.report, "f3")).toMatchObject({ unshrunkReason: "deadline" });
  });

  it("a zero budget before the witness phase launches no forge process", async () => {
    const w = world(happy());
    const disc = w.runner.script.discovery!;
    w.runner.script.discovery = (c) => {
      const r = disc(c);
      w.clock.t = DEADLINE_PASSED; // discovery finished, but the deadline has passed
      return r;
    };
    const r = await runOk(w);
    expect(w.runner.phases()).toEqual(["build", "discovery"]);
    expect(r.report.shrinking).toMatchObject({ deadlineReached: true, pairsUnshrunk: 2 });
    expect(finding(r.report, "transfer")).toMatchObject({ unshrunkReason: "deadline" });
  });

  it("replay timeout: finished replays stay shrunk, the rest are deadline, the report is written", async () => {
    const w = world(happy({ abiJson: ABI3, pairs: THREE }));
    const rep = w.runner.script.replay!;
    w.runner.script.replay = (c, k) => {
      if (k === 2) {
        w.clock.t = DEADLINE_PASSED;
        return { timedOut: true, code: null };
      }
      return rep(c, k);
    };
    const r = await runOk(w);
    expect(w.runner.phases()).toEqual(["build", "discovery", "witness1", "witness2", "witness3", "replay1", "replay2"]);
    expect(r.report.shrinking).toMatchObject({ deadlineReached: true, pairsShrunk: 1, pairsUnshrunk: 2 });
    expect(finding(r.report, "f1").unshrunk).toBeUndefined();
    expect(finding(r.report, "f2")).toMatchObject({ unshrunk: true, unshrunkReason: "deadline" });
    expect(finding(r.report, "f3")).toMatchObject({ unshrunk: true, unshrunkReason: "deadline" });
    expect(validateReport(r.report).ok).toBe(true);
    expect(existsSync(r.reportPath!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Faults in later phases
// ---------------------------------------------------------------------------

describe("other failures", () => {
  it("SEANCE_FAILED when the record stream breaks the taint rule", async () => {
    const recs = [rec(0, "transfer", "port-bug"), rec(1, "balanceOf", "match")]; // second record should be tainted
    const e = await runErr(world(happy({ discoveryRecords: recs })));
    expect(e.code).toBe("SEANCE_FAILED");
  });

  it("SEANCE_FAILED when discovery wrote no record file", async () => {
    const s = happy();
    s.discovery = () => ({ stdout: statusJson("SeanceDiscovery", "invariant_discovery", "Success") });
    const e = await runErr(world(s));
    expect(e.code).toBe("SEANCE_FAILED");
    expect(e.message).toContain("records.jsonl");
  });

  it("SEANCE_FAILED when a witness run prints no JSON", async () => {
    const s = happy();
    s.witness = () => ({ code: 1, stdout: "", stderr: "crashed" });
    const e = await runErr(world(s));
    expect(e.code).toBe("SEANCE_FAILED");
    expect(e.message).toContain("witness campaign 1");
  });

  it("SEANCE_FAILED when a runner call throws, with the project kept", async () => {
    const s = happy();
    s.discovery = () => {
      throw new Error("spawn exploded");
    };
    const w = world(s);
    const e = await runErr(w);
    expect(e.code).toBe("SEANCE_FAILED");
    expect(e.message).toContain("spawn exploded");
    expect(tempDirs(w)).toHaveLength(1);
  });

  it("REPORT_WRITE_FAILED keeps the project", async () => {
    const w = world(happy(), { graveyardName: "bad/name" });
    const e = await runErr(w);
    expect(e.code).toBe("INVALID_INPUT");
    expect(tempDirs(w)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("helpers", () => {
  it("partialCountsFromJsonl counts complete lines only and can drop the last sequence", () => {
    const text = jsonl([rec(-1, "a", "match"), rec(0, "a", "match"), rec(1, "a", "port-bug"), rec(0, "a", "exorcised")]);
    expect(partialCountsFromJsonl(text + "{\"idx\":1,\"classi")).toEqual({ match: 2, "reason-modernised": 0, exorcised: 1, "port-bug": 1 });
    expect(partialCountsFromJsonl(text, { dropLastSequence: true })).toEqual({ match: 2, "reason-modernised": 0, exorcised: 0, "port-bug": 1 });
    expect(partialCountsFromJsonl("")).toEqual({ match: 0, "reason-modernised": 0, exorcised: 0, "port-bug": 0 });
    // a line that is a complete record but with the newline missing is incomplete
    expect(partialCountsFromJsonl(JSON.stringify(rec(0, "a", "match")))).toEqual({ match: 0, "reason-modernised": 0, exorcised: 0, "port-bug": 0 });
  });

  it("parseForgeJson tolerates log lines before the JSON", () => {
    expect(parseForgeJson('compiling...\n{"a":1}\n')).toEqual({ a: 1 });
    expect(parseForgeJson("")).toBeUndefined();
    expect(parseForgeJson("nope")).toBeUndefined();
  });

  it("failingFilesFromOutput reads both compiler formats", () => {
    expect(failingFilesFromOutput(" --> src/a.sol:1:2:\nsrc/b.sol:3:4: Error\n --> src/a.sol:9:9:")).toEqual(["src/a.sol", "src/b.sol"]);
  });
});

// ---------------------------------------------------------------------------
// The real process runner
// ---------------------------------------------------------------------------

describe("createProcessRunner", () => {
  const node = process.execPath;
  it("captures stdout, stderr and the exit code", async () => {
    const r = await createProcessRunner().run(node, ["-e", "console.log('out');console.error('err');process.exit(3)"], {
      cwd: tmpdir(),
      env: {},
      timeoutMs: 10_000,
    });
    expect(r).toEqual({ code: 3, stdout: "out\n", stderr: "err\n", timedOut: false });
  });

  it("passes the extra environment", async () => {
    const r = await createProcessRunner().run(node, ["-e", "console.log(process.env.SEANCE_RECORD)"], {
      cwd: tmpdir(),
      env: { SEANCE_RECORD: "1" },
      timeoutMs: 10_000,
    });
    expect(r.stdout).toBe("1\n");
  });

  it("SIGTERM at the deadline", async () => {
    const t0 = Date.now();
    const r = await createProcessRunner({ killGraceMs: 2_000 }).run(node, ["-e", "setInterval(()=>{},1000)"], {
      cwd: tmpdir(),
      env: {},
      timeoutMs: 300,
    });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("SIGKILL after the grace when SIGTERM is ignored, and the child's own children die too", async () => {
    const pidFile = join(mk(), "child.pid");
    const script = `
      const { spawn } = require("node:child_process");
      const c = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `;
    const t0 = Date.now();
    const r = await createProcessRunner({ killGraceMs: 400 }).run(node, ["-e", script], { cwd: tmpdir(), env: {}, timeoutMs: 700 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_000); // had to wait for the SIGKILL
    expect(Date.now() - t0).toBeLessThan(5_000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((res) => setTimeout(res, 200));
    expect(() => process.kill(pid, 0)).toThrow(); // grandchild is gone
  });

  it("reports a missing executable as a failed run, not a throw", async () => {
    const r = await createProcessRunner().run("/nonexistent/forge", [], { cwd: tmpdir(), env: {}, timeoutMs: 1_000 });
    expect(r.code).toBeNull();
    expect(r.stderr).toContain("could not run");
    expect(r.timedOut).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Real forge, end to end, on the token fixture
// ---------------------------------------------------------------------------

const solc = listInstalledSolc();
const e2eSkip = skipReason !== "" ? skipReason : !solc.includes("0.4.19") || !solc.includes("0.8.28") ? "solc 0.4.19 and 0.8.28 are not both installed" : "";

describe.skipIf(e2eSkip !== "")(`real forge on the token fixture${e2eSkip ? ` (skipped: ${e2eSkip})` : ""}`, () => {
  /** Runtime code of the legacy build: a first build in a scratch directory (the on-chain code of this fixture). */
  function legacyRuntimeCode(): string {
    const scratch = mk();
    const dir = join(scratch, "p");
    const files = generateSrcProject(input(), { forgeStdDir: LOCAL_STD });
    if (!files.ok) throw new Error(files.error.message);
    const w = writeProjectFiles(dir, files.value, { mode: "fresh" });
    if (!w.ok) throw new Error(w.error.message);
    const b = spawnSync("forge", ["build", "--offline"], { cwd: dir, encoding: "utf8" });
    if (b.status !== 0) throw new Error(`scratch build failed: ${b.stdout}${b.stderr}`);
    const a = readLegacyArtifact(join(dir, "out"), "Token");
    if (!a.ok) throw new Error(a.error.message);
    return a.value.runtimeCode;
  }

  it(
    "completes the whole run: valid report, a shrunk replay-confirmed batchTransfer exorcism, no port bugs",
    async () => {
      const code = legacyRuntimeCode();
      const tmp = mk();
      const grave = mk();
      const t0 = Date.now();
      const r = await runSeance(input({ autopsyReport: AUTOPSY, onChainRuntimeCode: code }), {
        runner: createProcessRunner(),
        now: Date.now,
        tmpRoot: tmp,
        forgeStdDir: LOCAL_STD,
        graveyardRoot: grave,
      });
      const ms = Date.now() - t0;
      // eslint-disable-next-line no-console
      console.log(`[10.4 e2e] native forge run took ${ms} ms`);
      if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
      const rep = r.value.report;
      expect(ms).toBeLessThan(60_000);
      expect(validateReport(rep).ok).toBe(true);
      expect(r.value.reportPath).toBe(join(grave, "Token", "seance-report.json"));
      const onDisk = parseReport(readFileSync(r.value.reportPath!, "utf8"));
      expect(onDisk.ok && onDisk.value).toEqual(rep);

      expect(rep.counts.match + rep.counts["reason-modernised"] + rep.counts.exorcised + rep.counts["port-bug"]).toBe(rep.totalCalls);
      expect(rep.totalCalls).toBeLessThanOrEqual(rep.setupCalls + INVARIANT_RUNS * 64);
      expect(rep.portBugs).toEqual([]);
      expect(rep.counts["port-bug"]).toBe(0);
      expect(rep.seed).toBe("42");

      const ex = rep.exorcisms.find((f) => f.function === "batchTransfer");
      expect(ex).toBeDefined();
      expect(ex!.unshrunk).toBeUndefined(); // shrunk, and the replay confirmed its classification
      expect(ex!.originalLength).toBeGreaterThanOrEqual(1);
      expect(rep.shrinking.pairsShrunk).toBeGreaterThanOrEqual(1);
      expect(rep.shrinking.deadlineReached).toBe(false);
      expect(ex!.precedingCalls.length).toBeLessThanOrEqual(3);
      expect(readdirSync(tmp).filter((d) => d.startsWith("exhume-seance-"))).toEqual([]); // removed on success
    },
    FORGE_TIMEOUT,
  );

  it(
    "BYTECODE_MISMATCH with real forge stops after the build",
    async () => {
      const tmp = mk();
      const r = await runSeance(input({ onChainRuntimeCode: "0x6080604052" }), {
        runner: createProcessRunner(),
        now: Date.now,
        tmpRoot: tmp,
        forgeStdDir: LOCAL_STD,
      });
      expect(!r.ok && r.error.code).toBe("BYTECODE_MISMATCH");
      const dir = join(tmp, readdirSync(tmp)[0]!);
      expect(existsSync(join(dir, "test"))).toBe(false);
      expect(existsSync(join(dir, "seance-out"))).toBe(false);
    },
    FORGE_TIMEOUT,
  );
});
