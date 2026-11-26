/**
 * Task 11.1: the Entry_Point library layer (entry.ts). A scripted ProcessRunner (no forge) checks
 * pass-through of errors, defaults, environment overrides, the report path and the throwing
 * wrapper. One real-forge test runs the BEC graveyard entry through the entry.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listInstalledSolc } from "../../src/seance/bytecode.js";
import {
  ENV_FORGE_BIN,
  ENV_FORGE_STD_DIR,
  SeanceErrorException,
  defaultGraveyardRoot,
  runSeanceEntry,
  runSeanceOrThrow,
} from "../../src/seance/entry.js";
import { loadGraveyardInput } from "../../src/seance/graveyard.js";
import * as api from "../../src/seance/index.js";
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from "../../src/seance/process-runner.js";
import { parseReport, validateReport } from "../../src/seance/report.js";
import type { RecordLine, SeanceInput } from "../../src/seance/types.js";
import { DOCKER_TOKEN, ENGINE, LOCAL_STD, skipReason } from "./template-project.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LEGACY_SRC = readFileSync(join(DOCKER_TOKEN, "src/legacy/LegacyToken.sol"), "utf8");
const PORT_SRC = readFileSync(join(DOCKER_TOKEN, "src/port/PortToken.sol"), "utf8");
const FAKE_CODE = "0x608060405234801561001057600080fd5b50";
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
    ...over,
  } as SeanceInput;
}

const ABI = [
  { type: "constructor", inputs: [], stateMutability: "nonpayable" },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "_owner", type: "address" }],
    outputs: [],
    stateMutability: "view",
  },
  { type: "function", name: "ping", inputs: [], outputs: [], stateMutability: "nonpayable" },
];

const wire = { success: true, data: "0x", logs: [], stateHash: "0x" + "00".repeat(32) };
const MATCH: RecordLine = {
  idx: 0,
  function: "balanceOf",
  selector: "0x70a08231",
  calldata: "0x70a08231" + "00".repeat(32),
  sender: "0x" + "11".repeat(20),
  value: "0",
  legacy: wire,
  port: wire,
  classification: "match",
  differingFields: [],
  invalidRecord: false,
  afterDivergence: false,
};

// ---------------------------------------------------------------------------
// Scripted runner
// ---------------------------------------------------------------------------

interface Call {
  cmd: string;
  args: string[];
  opts: ProcessRunOptions;
  remappings: string;
}
type Handler = (c: Call) => Partial<ProcessResult>;

class Fake implements ProcessRunner {
  calls: Call[] = [];
  constructor(private readonly onCall: Handler) {}
  run(cmd: string, args: string[], opts: ProcessRunOptions): Promise<ProcessResult> {
    const rp = join(opts.cwd, "remappings.txt");
    const c: Call = { cmd, args, opts, remappings: existsSync(rp) ? readFileSync(rp, "utf8") : "" };
    this.calls.push(c);
    return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false, ...this.onCall(c) });
  }
}

const put = (cwd: string, rel: string, text: string): void => {
  const p = join(cwd, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

/** Build and discovery succeed; discovery saw one sequence with one matching call. No findings. */
const happy: Handler = (c) => {
  if (c.args[0] === "build") {
    put(c.opts.cwd, "out/LegacyToken.sol/Token.json", JSON.stringify({ abi: ABI, deployedBytecode: { object: FAKE_CODE } }));
    put(c.opts.cwd, "out/PortToken.sol/Token.json", JSON.stringify({ abi: ABI, deployedBytecode: { object: "0x6001" } }));
    return {};
  }
  put(c.opts.cwd, "seance-out/records.jsonl", JSON.stringify(MATCH) + "\n");
  return {
    stdout: JSON.stringify({
      "test/X.t.sol:SeanceDiscovery": {
        test_results: {
          "invariant_discovery()": {
            status: "Success",
            reason: null,
            counterexample: null,
            kind: { Invariant: { runs: 256, calls: 16384, reverts: 0 } },
          },
        },
      },
    }),
  };
};

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {
      // already gone
    }
    rmSync(d, { recursive: true, force: true });
  }
});
const mk = (): string => {
  const d = mkdtempSync(join(tmpdir(), "exhume-entry-"));
  cleanup.push(d);
  return d;
};

function opts(runner: ProcessRunner, over: Record<string, unknown> = {}) {
  return {
    runner,
    tmpRoot: mk(),
    graveyardRoot: mk(),
    solcInstalled: ["0.4.19", "0.8.28"],
    forgeStdDir: "/opt/forge-std",
    env: {},
    now: () => 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("entry: errors pass through unchanged", () => {
  it("MISSING_INPUT names the missing fields and starts no run", async () => {
    const f = new Fake(happy);
    const r = await runSeanceEntry({ contractName: "Token" }, opts(f));
    expect(!r.ok && r.error.code).toBe("MISSING_INPUT");
    expect(!r.ok && (r.error.details as { fields: string[] }).fields).toContain("legacySource");
    expect(f.calls).toEqual([]);
  });

  it("INVALID_INPUT names the invalid fields and starts no run", async () => {
    const f = new Fake(happy);
    const r = await runSeanceEntry(input({ contractName: "" }), opts(f));
    expect(!r.ok && r.error.code).toBe("INVALID_INPUT");
    expect(!r.ok && (r.error.details as { fields: string[] }).fields).toContain("contractName");
    expect(f.calls).toEqual([]);
  });

  it("SOLC_MISSING makes no forge call", async () => {
    const f = new Fake(happy);
    const r = await runSeanceEntry(input(), opts(f, { solcInstalled: ["0.4.26"] }));
    expect(!r.ok && r.error.code).toBe("SOLC_MISSING");
    expect(f.calls).toEqual([]);
  });
});

describe("entry: unexpected failures become SEANCE_FAILED", () => {
  it("an exception thrown by the process runner", async () => {
    const f = new Fake(() => {
      throw new Error("spawn exploded \u00e9");
    });
    const r = await runSeanceEntry(input(), opts(f));
    expect(!r.ok && r.error.code).toBe("SEANCE_FAILED");
    expect(!r.ok && r.error.message).toContain("spawn exploded");
  });

  it("an exception outside the runner's own guard (solc provider) never rejects, and is ASCII", async () => {
    const f = new Fake(happy);
    const r = await runSeanceEntry(
      input(),
      opts(f, {
        solcInstalled: () => {
          throw new Error("svm \u00e9 broke");
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("SEANCE_FAILED");
    expect(r.error.message).toContain("svm ? broke");
    expect(/^[\x20-\x7e\n]*$/.test(JSON.stringify(r.error.details))).toBe(true);
    expect(f.calls).toEqual([]);
  });

  it("a non-Error throw is wrapped too", async () => {
    const r = await runSeanceEntry(
      input(),
      opts(new Fake(happy), {
        solcInstalled: () => {
          throw "plain string";
        },
      }),
    );
    expect(!r.ok && r.error.code).toBe("SEANCE_FAILED");
  });
});

describe("entry: defaults and overrides", () => {
  it("default timeout is 300 s: the build gets 300000 ms from the injected clock", async () => {
    const f = new Fake(() => ({ code: 1 }));
    const r = await runSeanceEntry(input(), opts(f, { keepTempOnFailure: false }));
    expect(!r.ok && r.error.code).toBe("BUILD_FAILED");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.opts.timeoutMs).toBe(300_000);
    expect(f.calls[0]!.cmd).toBe("forge");
    expect(f.calls[0]!.remappings).toBe("forge-std/=/opt/forge-std/src/\n");
  });

  it("a configured timeoutSeconds reaches the deadline", async () => {
    const f = new Fake(() => ({ code: 1 }));
    await runSeanceEntry(input({ timeoutSeconds: 42 }), opts(f, { keepTempOnFailure: false }));
    expect(f.calls[0]!.opts.timeoutMs).toBe(42_000);
  });

  it("SEANCE_FORGE_BIN and SEANCE_FORGE_STD_DIR from the environment reach the runner", async () => {
    const f = new Fake(() => ({ code: 1 }));
    const env = { [ENV_FORGE_BIN]: "/custom/forge", [ENV_FORGE_STD_DIR]: "/custom/std" };
    const o = opts(f, { keepTempOnFailure: false, env });
    delete (o as { forgeStdDir?: string }).forgeStdDir;
    await runSeanceEntry(input(), o);
    expect(f.calls[0]!.cmd).toBe("/custom/forge");
    expect(f.calls[0]!.remappings).toBe("forge-std/=/custom/std/src/\n");
  });

  it("explicit options win over the environment", async () => {
    const f = new Fake(() => ({ code: 1 }));
    const env = { [ENV_FORGE_BIN]: "/env/forge", [ENV_FORGE_STD_DIR]: "/env/std" };
    await runSeanceEntry(input(), opts(f, { keepTempOnFailure: false, env, forgeBin: "/opt/forge", forgeStdDir: "/opt/std" }));
    expect(f.calls[0]!.cmd).toBe("/opt/forge");
    expect(f.calls[0]!.remappings).toBe("forge-std/=/opt/std/src/\n");
  });

  it("the default graveyard root is <repo>/graveyard", () => {
    expect(defaultGraveyardRoot()).toBe(resolve(ENGINE, "../graveyard"));
  });
});

describe("entry: report path", () => {
  it("writes <graveyardRoot>/<contract>/seance-report.json and returns it with reportPath", async () => {
    const o = opts(new Fake(happy));
    const r = await runSeanceEntry(input(), o);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    const expected = join(o.graveyardRoot, "Token", "seance-report.json");
    expect(r.value.reportPath).toBe(expected);
    const onDisk = parseReport(readFileSync(expected, "utf8"));
    expect(onDisk.ok).toBe(true);
    expect(validateReport(r.value.report).ok).toBe(true);
    expect(onDisk.ok && onDisk.value).toEqual(r.value.report);
  });

  it("graveyardName overrides the directory", async () => {
    const o = opts(new Fake(happy), { graveyardName: "bec" });
    const r = await runSeanceEntry(input(), o);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    expect(r.value.reportPath).toBe(join(o.graveyardRoot, "bec", "seance-report.json"));
    expect(existsSync(join(o.graveyardRoot, "Token"))).toBe(false);
  });

  const root = typeof process.getuid === "function" && process.getuid() === 0;
  it.skipIf(root || process.platform === "win32")("REPORT_WRITE_FAILED leaves the previous report unchanged", async () => {
    const o = opts(new Fake(happy));
    const dir = join(o.graveyardRoot, "Token");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "seance-report.json");
    writeFileSync(target, "previous report\n");
    chmodSync(dir, 0o500);
    const r = await runSeanceEntry(input(), o);
    chmodSync(dir, 0o700);
    expect(!r.ok && r.error.code).toBe("REPORT_WRITE_FAILED");
    expect(readFileSync(target, "utf8")).toBe("previous report\n");
  });
});

describe("entry: throwing wrapper", () => {
  it("rejects with a SeanceErrorException carrying the SeanceError", async () => {
    const p = runSeanceOrThrow({ contractName: "Token" }, opts(new Fake(happy)));
    await expect(p).rejects.toBeInstanceOf(SeanceErrorException);
    const e = (await p.catch((x: unknown) => x)) as SeanceErrorException;
    expect(e.error.code).toBe("MISSING_INPUT");
    expect(e.message).toContain("MISSING_INPUT");
  });

  it("resolves with the run result on success", async () => {
    const v = await runSeanceOrThrow(input(), opts(new Fake(happy)));
    expect(v.reportPath).toBeDefined();
    expect(v.report.contract).toBe("Token");
  });
});

describe("package index", () => {
  it("exports the entry as runSeance and the runner as runSeanceWithDeps", () => {
    expect(api.runSeance).toBe(runSeanceEntry);
    expect(typeof api.runSeanceWithDeps).toBe("function");
    expect(api.runSeanceWithDeps).not.toBe(api.runSeance);
    expect(typeof api.loadGraveyardInput).toBe("function");
    expect(typeof api.runBecAcceptance).toBe("function");
    expect(api.autopsySchema).toBeDefined();
    expect(api.seanceReportSchema).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Real forge, BEC through the entry
// ---------------------------------------------------------------------------

const solcNow = listInstalledSolc();
const e2eSkip =
  skipReason !== ""
    ? skipReason
    : !solcNow.includes("0.4.19") || !solcNow.includes("0.8.28")
      ? "solc 0.4.19 and 0.8.28 are not both installed"
      : "";

describe.skipIf(e2eSkip !== "")(`entry with real forge on BEC${e2eSkip ? ` (skipped: ${e2eSkip})` : ""}`, () => {
  it(
    "completes and writes a valid report with no port bugs",
    async () => {
      const loaded = loadGraveyardInput(resolve(ENGINE, "../graveyard"), "bec", { timeoutSeconds: 165 });
      if (!loaded.ok) throw new Error(`${loaded.error.code}: ${loaded.error.message}`);
      const grave = mk();
      const r = await runSeanceEntry(loaded.value, { graveyardRoot: grave, tmpRoot: mk(), forgeStdDir: LOCAL_STD, env: {}, graveyardName: "bec" });
      if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
      const path = join(grave, "bec", "seance-report.json");
      expect(r.value.reportPath).toBe(path);
      expect(existsSync(path)).toBe(true);
      const onDisk = parseReport(readFileSync(path, "utf8"));
      expect(onDisk.ok).toBe(true);
      expect(validateReport(r.value.report).ok).toBe(true);
      expect(r.value.report.counts["port-bug"]).toBe(0);
    },
    180_000,
  );
});
