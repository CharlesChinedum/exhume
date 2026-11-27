/**
 * Task 11.2: the Entry_Point CLI (cli.ts). `main()` is driven with collected stdout/stderr and an
 * injected runner seam. Two tests spawn the real program (tsx), and one real BEC run is skipped when
 * forge, forge-std or solc 0.4.19 is missing.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BecAcceptanceRun } from "../../src/seance/acceptance.js";
import { listInstalledSolc } from "../../src/seance/bytecode.js";
import {
  EXIT_ACCEPTANCE,
  EXIT_ENVIRONMENT,
  EXIT_INPUT,
  EXIT_RUN,
  EXIT_TIMEOUT,
  EXIT_UNEXPECTED,
  exitCodeFor,
  main,
  normalizeCliInputFile,
  type CliDeps,
  type CliIo,
} from "../../src/seance/cli.js";
import type { SeanceOptions } from "../../src/seance/entry.js";
import { parseReport, serializeReport, validateReport } from "../../src/seance/report.js";
import type { SeanceRunResult } from "../../src/seance/runner.js";
import {
  SEANCE_ERROR_CODES,
  err,
  ok,
  seanceError,
  timeoutError,
  type Result,
  type SeanceError,
  type SeanceReport,
} from "../../src/seance/types.js";
import { ENGINE, LOCAL_STD, forgeOk, stdOk } from "./template-project.js";

const REPO = resolve(ENGINE, "..");
const GRAVEYARD = join(REPO, "graveyard");
const dirs: string[] = [];
const mk = (): string => {
  const d = mkdtempSync(join(tmpdir(), "exhume-cli-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const REPORT: SeanceReport = {
  schemaVersion: "1",
  contract: "Token",
  seed: "1",
  runs: 256,
  depth: 64,
  totalCalls: 10,
  counts: { match: 10, "reason-modernised": 0, exorcised: 0, "port-bug": 0 },
  taintedCalls: 0,
  setupCalls: 2,
  firstExorcismFuzzOrdinal: null,
  exorcisms: [],
  portBugs: [],
  sequenceResults: { total: 1, endedExorcised: 0, exorcisedAtIndex: [] },
  shrinking: { witnessCap: 10, pairsFound: 0, pairsSetup: 0, pairsShrunk: 0, pairsUnshrunk: 0, pairsOverCap: 0, deadlineReached: false },
  unreachableSites: [],
  skippedFunctions: [],
};

interface Run {
  code: number;
  out: string;
  errText: string;
  json: any;
}
async function run(argv: string[], deps: CliDeps = {}, io: Partial<CliIo> = {}): Promise<Run> {
  let out = "";
  let errText = "";
  const code = await main(argv, { stdout: (t) => void (out += t), stderr: (t) => void (errText += t), ...io }, deps);
  let json: unknown;
  try {
    json = JSON.parse(out);
  } catch {
    json = undefined;
  }
  return { code, out, errText, json };
}

/** A runner seam that records its calls and returns `result`. */
function seam(result: Result<SeanceRunResult>) {
  const calls: { input: any; opts: SeanceOptions }[] = [];
  const deps: CliDeps = {
    runSeance: async (input, opts) => {
      calls.push({ input, opts });
      return result;
    },
  };
  return { calls, deps };
}
const success = ok<SeanceRunResult>({ report: REPORT, reportPath: "/tmp/g/Token/seance-report.json" });

/** A graveyard entry in a temp dir (copied from the real BEC entry). */
function tempGraveyard(): string {
  const root = mk();
  cpSync(join(GRAVEYARD, "bec"), join(root, "bec"), { recursive: true });
  return root;
}

describe("cli: usage", () => {
  it("--help prints the usage on stdout and exits 0", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("seance run --graveyard <name>");
    expect(r.out).toContain("--input <file.json>");
    expect(r.out).toContain("legacySourcePath");
    expect(r.errText).toBe("");
  });

  it("ignores a leading -- forwarded by pnpm", async () => {
    expect((await run(["--", "--help"])).code).toBe(0);
  });

  it.each([
    [[], "Missing command"],
    [["frobnicate"], "Unknown command"],
    [["run", "--bogus", "1"], "Unknown flag: --bogus"],
    [["run", "--graveyard"], "needs a value"],
    [["run", "--graveyard", "bec", "stray"], "Unexpected argument"],
    [["run", "--graveyard", "a", "--graveyard", "b"], "more than once"],
    [["accept-bec", "--graveyard", "bec"], "Unknown flag: --graveyard"],
  ])("usage error %j exits 2 with an INVALID_INPUT document", async (argv, text) => {
    const r = await run(argv);
    expect(r.code).toBe(EXIT_INPUT);
    expect(r.json.error.code).toBe("INVALID_INPUT");
    expect(r.json.error.message).toContain(text);
    expect(r.errText).toContain("--help");
  });

  it("run without --graveyard and --input is MISSING_INPUT (exit 2)", async () => {
    const r = await run(["run"]);
    expect(r.code).toBe(2);
    expect(r.json.error.code).toBe("MISSING_INPUT");
  });

  it("run with both --graveyard and --input is INVALID_INPUT (exit 2)", async () => {
    const r = await run(["run", "--graveyard", "bec", "--input", "x.json"]);
    expect(r.code).toBe(2);
    expect(r.json.error.code).toBe("INVALID_INPUT");
  });

  it.each([
    [["--timeout", "abc"], "--timeout"],
    [["--timeout", "-5"], "--timeout"],
    [["--seed", "banana"], "--seed"],
  ])("bad value %j is a usage error", async (extra, text) => {
    const s = seam(success);
    const r = await run(["run", "--graveyard", "bec", ...extra], s.deps);
    expect(r.code).toBe(2);
    expect(r.json.error.message).toContain(text);
    expect(s.calls).toHaveLength(0);
  });
});

describe("cli: exit codes and error documents", () => {
  const table: [string, number][] = [
    ["MISSING_INPUT", 2],
    ["INVALID_INPUT", 2],
    ["AUTOPSY_REJECTED", 2],
    ["SOLC_MISSING", 3],
    ["BUILD_FAILED", 3],
    ["BYTECODE_MISMATCH", 3],
    ["TIMEOUT", 4],
    ["HANDLER_FAULT", 5],
    ["SEANCE_FAILED", 5],
    ["REPORT_WRITE_FAILED", 5],
    ["ACCEPTANCE_FAILED", 6],
  ];

  it("the table covers every error code", () => {
    expect(table.map(([c]) => c).sort()).toEqual([...SEANCE_ERROR_CODES].sort());
    for (const [c, n] of table) expect(exitCodeFor(c)).toBe(n);
    expect(exitCodeFor("SOMETHING_ELSE")).toBe(EXIT_UNEXPECTED);
  });

  const plain = table.map(([c]) => c).filter((c) => c !== "TIMEOUT" && c !== "HANDLER_FAULT");
  it.each(plain)("%s becomes {error:{code,message,details}} with its exit code", async (code) => {
    const s = seam(err(seanceError(code as never, `boom ${code}`, { a: 1 })));
    const r = await run(["run", "--graveyard", "bec", "--graveyard-root", tempGraveyard()], s.deps);
    expect(r.code).toBe(table.find(([c]) => c === code)![1]);
    expect(r.json).toEqual({ error: { code, message: `boom ${code}`, details: { a: 1 } } });
    expect(r.out.endsWith("\n")).toBe(true);
  });

  it("TIMEOUT in build carries the phase and no partialCounts (exit 4)", async () => {
    const s = seam(err(timeoutError("build", "deadline during forge build")));
    const r = await run(["run", "--graveyard", "bec", "--graveyard-root", tempGraveyard()], s.deps);
    expect(r.code).toBe(EXIT_TIMEOUT);
    expect(r.json).toEqual({ error: { code: "TIMEOUT", message: "deadline during forge build", phase: "build" } });
  });

  it("TIMEOUT in discovery carries phase and partialCounts (exit 4)", async () => {
    const counts = { match: 5, "reason-modernised": 1, exorcised: 2, "port-bug": 0 };
    const s = seam(err(timeoutError("discovery", "deadline during discovery", { partialCounts: counts })));
    const r = await run(["run", "--graveyard", "bec", "--graveyard-root", tempGraveyard()], s.deps);
    expect(r.code).toBe(4);
    expect(r.json.error).toMatchObject({ code: "TIMEOUT", phase: "discovery", partialCounts: counts });
  });

  it("HANDLER_FAULT carries partialCounts (exit 5)", async () => {
    const counts = { match: 1, "reason-modernised": 0, exorcised: 0, "port-bug": 0 };
    const e: SeanceError = { code: "HANDLER_FAULT", message: "invariant failed", partialCounts: counts };
    const r = await run(["run", "--graveyard", "bec", "--graveyard-root", tempGraveyard()], seam(err(e)).deps);
    expect(r.code).toBe(EXIT_RUN);
    expect(r.json.error.partialCounts).toEqual(counts);
  });

  it("a graveyard entry that does not exist is INVALID_INPUT (exit 2) and starts no run", async () => {
    const s = seam(success);
    const r = await run(["run", "--graveyard", "nope", "--graveyard-root", mk()], s.deps);
    expect(r.code).toBe(2);
    expect(r.json.error.code).toBe("INVALID_INPUT");
    expect(s.calls).toHaveLength(0);
  });

  it("an unexpected exception is SEANCE_FAILED with exit 1 and no stack on stdout or stderr", async () => {
    const deps: CliDeps = {
      runSeance: async () => {
        throw new Error("kaboom\n    at secret (file.ts:1:1)");
      },
    };
    const r = await run(["run", "--graveyard", "bec", "--graveyard-root", tempGraveyard()], deps);
    expect(r.code).toBe(EXIT_UNEXPECTED);
    expect(r.json.error.code).toBe("SEANCE_FAILED");
    expect(r.json.error.message).toContain("kaboom");
    expect(r.out).not.toContain("at secret");
    expect(r.errText).not.toContain("at secret");
  });

  it("--debug prints the stack of an unexpected exception on stderr only", async () => {
    const deps: CliDeps = {
      runSeance: async () => {
        throw new Error("kaboom");
      },
    };
    const r = await run(["run", "--graveyard", "bec", "--graveyard-root", tempGraveyard(), "--debug"], deps);
    expect(r.code).toBe(1);
    expect(r.errText).toContain("kaboom");
    expect(r.errText).toContain("at ");
    expect(r.out).not.toContain("    at ");
  });

  it("drops a folded stack (stackHint, 'unexpected failure' multi-line message) unless --debug", async () => {
    const e = seanceError("SEANCE_FAILED", "unexpected failure: x\n    at y (z.ts:1:1)", { stackHint: "    at q", keep: 1 });
    const argv = ["run", "--graveyard", "bec", "--graveyard-root", tempGraveyard()];
    const plainRun = await run(argv, seam(err(e)).deps);
    expect(plainRun.code).toBe(5);
    expect(plainRun.json.error).toEqual({ code: "SEANCE_FAILED", message: "unexpected failure: x", details: { keep: 1 } });
    const debugRun = await run([...argv, "--debug"], seam(err(e)).deps);
    expect(debugRun.json.error.details.stackHint).toBe("    at q");
  });
});

describe("cli: run --graveyard", () => {
  it("prints only the report on stdout, the path on stderr, and exits 0", async () => {
    const s = seam(success);
    const root = tempGraveyard();
    const r = await run(["run", "--graveyard", "bec", "--graveyard-root", root], s.deps);
    expect(r.code).toBe(0);
    expect(r.out).toBe(serializeReport(REPORT));
    expect(parseReport(r.out).ok).toBe(true);
    expect(r.errText).toContain("report written to /tmp/g/Token/seance-report.json");
    expect(r.out).not.toContain("report written");
    expect(s.calls[0]!.opts.graveyardName).toBe("bec");
    expect(s.calls[0]!.opts.graveyardRoot).toBe(root);
    expect(s.calls[0]!.input.contractName).toBe("BecToken");
  });

  it("parses --seed and --timeout and passes the forge options", async () => {
    const s = seam(success);
    const cwd = mk();
    const r = await run(
      ["run", "--graveyard=bec", "--graveyard-root", tempGraveyard(), "--seed", "0xAB", "--timeout=42", "--forge-std-dir", "std", "--forge-bin", "bin/forge", "--tmp-root", "t"],
      s.deps,
      { cwd },
    );
    expect(r.code).toBe(0);
    const { input, opts } = s.calls[0]!;
    expect(input.fuzzSeed).toBe("0xAB");
    expect(input.timeoutSeconds).toBe(42);
    expect(opts.forgeStdDir).toBe(join(cwd, "std"));
    expect(opts.forgeBin).toBe(join(cwd, "bin/forge"));
    expect(opts.tmpRoot).toBe(join(cwd, "t"));
  });

  it("keeps a bare --forge-bin name unresolved and defaults the timeout to the entry's", async () => {
    const s = seam(success);
    await run(["run", "--graveyard", "bec", "--graveyard-root", tempGraveyard(), "--forge-bin", "forge"], s.deps);
    expect(s.calls[0]!.opts.forgeBin).toBe("forge");
    expect(s.calls[0]!.input.timeoutSeconds).toBe(300);
  });
});

describe("normalizeCliInputFile", () => {
  it("reads *Path fields relative to the base directory and drops the *Path keys", () => {
    const dir = mk();
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "a.sol"), "contract A {}\n");
    writeFileSync(join(dir, "rt.hex"), "0x6080\n\n");
    const r = normalizeCliInputFile(
      { contractName: "A", legacySourcePath: "sub/a.sol", runtimeCodePath: "rt.hex", portSource: "inline" },
      dir,
    );
    expect(r).toEqual({ ok: true, value: { contractName: "A", legacySource: "contract A {}\n", onChainRuntimeCode: "0x6080", portSource: "inline" } });
  });

  it("accepts an absolute path", () => {
    const dir = mk();
    writeFileSync(join(dir, "p.sol"), "x");
    const r = normalizeCliInputFile({ portSourcePath: join(dir, "p.sol") }, "/nonexistent");
    expect(r).toEqual({ ok: true, value: { portSource: "x" } });
  });

  it("a missing file is INVALID_INPUT naming the field and path", () => {
    const r = normalizeCliInputFile({ autopsyReportPath: "gone.json" }, mk());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_INPUT");
      expect(r.error.message).toContain("autopsyReportPath");
      expect(r.error.message).toContain("gone.json");
    }
  });

  it("giving both the inline field and its path is INVALID_INPUT", () => {
    const r = normalizeCliInputFile({ legacySource: "a", legacySourcePath: "a.sol" }, mk());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_INPUT");
      expect(r.error.message).toContain("legacySource");
    }
  });

  it.each([[null], [[1]], ["text"], [3]])("a non-object (%j) is INVALID_INPUT", (v) => {
    const r = normalizeCliInputFile(v, mk());
    expect(r.ok).toBe(false);
  });

  it("a non-string or empty *Path is INVALID_INPUT", () => {
    expect(normalizeCliInputFile({ portSourcePath: 3 }, mk()).ok).toBe(false);
    expect(normalizeCliInputFile({ portSourcePath: "" }, mk()).ok).toBe(false);
  });
});

describe("cli: run --input", () => {
  function writeInput(dir: string, over: Record<string, unknown> = {}): string {
    writeFileSync(join(dir, "legacy.sol"), "contract L {}\n");
    writeFileSync(join(dir, "autopsy.json"), '{"schemaVersion":"1"}');
    const file = join(dir, "input.json");
    writeFileSync(
      file,
      JSON.stringify({
        contractName: "Token",
        legacySourcePath: "legacy.sol",
        portSource: "contract P {}\n",
        autopsyReportPath: "autopsy.json",
        legacySolcVersion: "0.4.19",
        legacyOptimizer: false,
        onChainRuntimeCode: "0x6080",
        ...over,
      }),
    );
    return file;
  }

  it("builds the input from inline and *Path fields; flags override the file's seed and timeout", async () => {
    const dir = mk();
    const file = writeInput(dir, { fuzzSeed: "5", timeoutSeconds: 9 });
    const s = seam(success);
    const r = await run(["run", "--input", file, "--timeout", "77", "--graveyard-root", dir], s.deps);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).contract).toBe("Token");
    expect(s.calls[0]!.input).toEqual({
      contractName: "Token",
      legacySource: "contract L {}\n",
      portSource: "contract P {}\n",
      autopsyReport: '{"schemaVersion":"1"}',
      legacySolcVersion: "0.4.19",
      legacyOptimizer: false,
      onChainRuntimeCode: "0x6080",
      fuzzSeed: "5",
      timeoutSeconds: 77,
    });
    expect(s.calls[0]!.opts.graveyardName).toBeUndefined();
  });

  it("resolves a relative --input against the cwd", async () => {
    const dir = mk();
    writeInput(dir);
    const s = seam(success);
    const r = await run(["run", "--input", "input.json"], s.deps, { cwd: dir });
    expect(r.code).toBe(0);
    expect(s.calls[0]!.input.legacySource).toBe("contract L {}\n");
  });

  it("a missing input file is INVALID_INPUT (exit 2)", async () => {
    const s = seam(success);
    const r = await run(["run", "--input", join(mk(), "nope.json")], s.deps);
    expect(r.code).toBe(2);
    expect(r.json.error.code).toBe("INVALID_INPUT");
    expect(s.calls).toHaveLength(0);
  });

  it("a file that is not JSON is INVALID_INPUT (exit 2)", async () => {
    const dir = mk();
    const file = join(dir, "bad.json");
    writeFileSync(file, "{ not json");
    const r = await run(["run", "--input", file], seam(success).deps);
    expect(r.code).toBe(2);
    expect(r.json.error.message).toContain("not valid JSON");
  });

  it("both inline and *Path is INVALID_INPUT (exit 2)", async () => {
    const dir = mk();
    const file = writeInput(dir, { legacySource: "x" });
    const r = await run(["run", "--input", file], seam(success).deps);
    expect(r.code).toBe(2);
    expect(r.json.error.code).toBe("INVALID_INPUT");
  });

  it("missing fields are reported by the real validation as MISSING_INPUT (exit 2) and no run starts", async () => {
    const dir = mk();
    const file = join(dir, "partial.json");
    writeFileSync(file, JSON.stringify({ contractName: "T" }));
    const r = await run(["run", "--input", file, "--tmp-root", dir, "--graveyard-root", dir]);
    expect(r.code).toBe(2);
    expect(r.json.error.code).toBe("MISSING_INPUT");
    expect(r.json.error.message).toContain("legacySource");
  });
});

describe("cli: accept-bec", () => {
  const acceptance = (result: Result<BecAcceptanceRun>) => {
    const calls: { opts: SeanceOptions; run: any }[] = [];
    const deps: CliDeps = {
      runAcceptance: async (opts, runOpts) => {
        calls.push({ opts, run: runOpts });
        return result;
      },
    };
    return { calls, deps };
  };

  it("prints the report, the path on stderr, exit 0", async () => {
    const a = acceptance(ok({ summary: {} as never, report: REPORT, reportPath: "/g/bec/seance-report.json" }));
    const r = await run(["accept-bec", "--graveyard-root", "/g", "--seed", "7", "--timeout", "100"], a.deps);
    expect(r.code).toBe(0);
    expect(r.out).toBe(serializeReport(REPORT));
    expect(r.errText).toContain("report written to /g/bec/seance-report.json");
    expect(a.calls[0]!.opts.graveyardRoot).toBe("/g");
    expect(a.calls[0]!.run).toEqual({ fuzzSeed: "7", timeoutSeconds: 100 });
  });

  it("ACCEPTANCE_FAILED prints the failing conditions and exits 6", async () => {
    const failed = [{ condition: "port-bug-count", observed: { counts: 1 }, expected: { counts: 0 } }];
    const a = acceptance(err(seanceError("ACCEPTANCE_FAILED", "BEC acceptance failed: port-bug-count", { failed })));
    const r = await run(["accept-bec"], a.deps);
    expect(r.code).toBe(EXIT_ACCEPTANCE);
    expect(r.json).toEqual({ error: { code: "ACCEPTANCE_FAILED", message: "BEC acceptance failed: port-bug-count", details: { failed } } });
  });

  it("a séance error during acceptance keeps its own code and exit code", async () => {
    const a = acceptance(err(seanceError("BUILD_FAILED", "nope")));
    expect((await run(["accept-bec"], a.deps)).code).toBe(EXIT_ENVIRONMENT);
  });

  it("an unexpected exception exits 1", async () => {
    const r = await run(["accept-bec"], {
      runAcceptance: async () => {
        throw new Error("x");
      },
    });
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe("SEANCE_FAILED");
  });
});

describe("cli: real process", () => {
  it("`pnpm --filter @exhume/engine seance -- --help` exits 0 and prints the usage", () => {
    const r = spawnSync("pnpm", ["--filter", "@exhume/engine", "seance", "--", "--help"], { cwd: REPO, encoding: "utf8", timeout: 60_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("seance run --graveyard <name>");
  }, 90_000);

  it("a bad flag exits 2 with the error JSON on stdout", () => {
    const r = spawnSync("pnpm", ["--filter", "@exhume/engine", "seance", "--", "run", "--bogus"], { cwd: REPO, encoding: "utf8", timeout: 60_000 });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('"code": "INVALID_INPUT"');
    expect(r.stdout.slice(r.stdout.indexOf("{"))).toBeTruthy();
  }, 90_000);
});

const solc = listInstalledSolc();
const skip = !forgeOk ? "forge is not installed" : !stdOk ? "forge-std is not available" : !solc.includes("0.4.19") ? "solc 0.4.19 is not installed" : "";
describe.skipIf(skip !== "")(`cli: real BEC run${skip ? ` (skipped: ${skip})` : ""}`, () => {
  it(
    "`seance run --graveyard bec` exits 0 and prints a valid report",
    async () => {
      const root = tempGraveyard();
      const tmp = mk();
      const tsx = join(ENGINE, "node_modules/.bin/tsx");
      const child = spawn(tsx, ["src/seance/cli.ts", "run", "--graveyard", "bec", "--graveyard-root", root, "--tmp-root", tmp, "--timeout", "150"], {
        cwd: ENGINE,
        env: { ...process.env, SEANCE_FORGE_STD_DIR: LOCAL_STD },
      });
      let out = "";
      let errText = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (errText += d));
      const code = await new Promise<number | null>((res) => child.on("close", res));
      expect(code, `${out.slice(0, 2000)}\n${errText.slice(-2000)}`).toBe(0);
      const parsed = parseReport(out);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(validateReport(parsed.value).ok).toBe(true);
      const path = join(root, "bec", "seance-report.json");
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(out);
      expect(errText).toContain(`report written to ${path}`);
    },
    180_000,
  );
});
