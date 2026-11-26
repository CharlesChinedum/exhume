/**
 * Task 8.5 follow-up: two-stage generation, writeProjectFiles, and the stack-depth skip (design decision 19).
 * Static tests need no forge; the forge tests (skipped when forge or the local forge-std is missing) compile
 * the generated projects natively. The calibration of MAX_HANDLER_STACK is in
 * engine/test/docker/findings/8.5.stack-limit.native.md.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseAutopsyReport } from "../../src/seance/autopsy-contract.js";
import { generateTargets } from "../../src/seance/input-generator.js";
import {
  MAX_HANDLER_STACK,
  computeSkippedFunctions,
  estimateHandlerStack,
  generateProject,
  generateSrcProject,
  generateTestProject,
  planHandlerFunctions,
  writeProjectFiles,
  type ProjectFiles,
} from "../../src/seance/project-generator.js";
import type { AbiFunction, SeanceInput, TargetPlan } from "../../src/seance/types.js";
import { FORGE_TIMEOUT, LOCAL_STD, skipReason } from "./template-project.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KINDS: Record<string, string> = {
  u: "uint256",
  s: "uint16",
  a: "address",
  b: "bool",
  n: "bytes32",
  B: "bytes",
  S: "string",
  A: "address[]",
  U: "uint16[]",
};

/** Function `name` whose parameters follow `code`, one character per parameter (see KINDS). */
function fn(name: string, code: string, mutability: AbiFunction["stateMutability"] = "nonpayable"): AbiFunction {
  return {
    type: "function",
    name,
    inputs: [...code].map((c, i) => ({ name: `x${i}`, type: KINDS[c] as string })),
    outputs: [],
    stateMutability: mutability,
  };
}

const INPUT: SeanceInput = {
  contractName: "T",
  legacySource: "pragma solidity ^0.4.19;\ncontract T { uint public x; }\n",
  portSource: "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract T { uint public x; }\n",
  autopsyReport: JSON.stringify({ schemaVersion: "1", contract: "T", sites: [] }),
  legacySolcVersion: "0.4.19",
  legacyOptimizer: false,
  onChainRuntimeCode: "0x6060604052",
};
const EMPTY_PLAN: TargetPlan = { sites: [], seedSequences: [] };
const STD = "/opt/forge-std";

const okVal = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
const file = (p: ProjectFiles, path: string): string => {
  const f = p.find((x) => x.path === path);
  if (!f) throw new Error(`no ${path}`);
  return f.contents;
};
const tmp = (): string => mkdtempSync(join(tmpdir(), "exhume-pgs-"));

/** Largest allowed: 2 + 2 + 3 (bytes, string, address[]) + 2 scalars = 9 cost units, so estimate 7 + 9 = 16. */
const LARGEST = "BSAus";
/** One parameter more. */
const SMALLEST_SKIPPED = LARGEST + "u";

// ---------------------------------------------------------------------------
// Estimator
// ---------------------------------------------------------------------------

describe("estimateHandlerStack / computeSkippedFunctions", () => {
  it("MAX_HANDLER_STACK is the calibrated 16 and the largest signature sits exactly on it", () => {
    expect(MAX_HANDLER_STACK).toBe(16);
    expect(estimateHandlerStack(fn("f", LARGEST))).toBe(MAX_HANDLER_STACK);
    expect(estimateHandlerStack(fn("f", SMALLEST_SKIPPED))).toBe(MAX_HANDLER_STACK + 1);
    expect(estimateHandlerStack(fn("f", "u".repeat(9)))).toBe(16);
    expect(estimateHandlerStack(fn("f", "u".repeat(8), "payable"))).toBe(16);
    expect(estimateHandlerStack(fn("f", "AAA"))).toBe(16);
    expect(estimateHandlerStack(fn("f", "BBBB"))).toBe(15);
  });

  it("never decreases when a parameter is added, and strictly increases (property)", () => {
    const code = fc.array(fc.constantFrom(...Object.keys(KINDS)), { maxLength: 14 }).map((a) => a.join(""));
    fc.assert(
      fc.property(code, fc.constantFrom(...Object.keys(KINDS)), fc.boolean(), (c, extra, payable) => {
        const m = payable ? "payable" : "nonpayable";
        const before = estimateHandlerStack(fn("f", c, m));
        expect(estimateHandlerStack(fn("f", c + extra, m))).toBeGreaterThan(before);
        expect(estimateHandlerStack(fn("f", extra + c, m))).toBe(estimateHandlerStack(fn("f", c + extra, m)));
        expect(estimateHandlerStack(fn("f", c, "payable"))).toBeGreaterThanOrEqual(estimateHandlerStack(fn("f", c, "nonpayable")));
      }),
      { numRuns: 200 },
    );
  });

  it("lists state-changing functions over the limit, sorted by name, once each", () => {
    const abi: AbiFunction[] = [
      fn("zeta", SMALLEST_SKIPPED),
      fn("small", "us"),
      fn("alpha", "u".repeat(12)),
      fn("viewy", SMALLEST_SKIPPED, "view"),
      fn("alpha", "u".repeat(13)), // overload: the name is listed once
      { type: "constructor", inputs: fn("c", "u".repeat(15)).inputs, stateMutability: "nonpayable" },
      { type: "fallback", inputs: [], stateMutability: "payable" },
    ];
    expect(computeSkippedFunctions(abi)).toEqual([
      { name: "alpha", reason: "stack" },
      { name: "zeta", reason: "stack" },
    ]);
    expect(computeSkippedFunctions([fn("ok", LARGEST)])).toEqual([]);
    expect(computeSkippedFunctions([fn("ok", LARGEST)], 15)).toEqual([{ name: "ok", reason: "stack" }]);
  });
});

// ---------------------------------------------------------------------------
// Generator behaviour with skipped functions (static)
// ---------------------------------------------------------------------------

const BIG = fn("big", "u".repeat(10)); // estimate 17: skipped
const TRANSFER: AbiFunction = {
  type: "function",
  name: "transfer",
  inputs: [{ name: "_to", type: "address" }, { name: "_value", type: "uint256" }],
  outputs: [{ name: "", type: "bool" }],
  stateMutability: "nonpayable",
};
const OK = fn("ok", "u");
const ABI = [OK, BIG, TRANSFER];

describe("generateTestProject with a skipped function", () => {
  const plan: TargetPlan = {
    sites: [],
    seedSequences: [
      [{ function: "big", args: Array.from({ length: 10 }, () => "1"), actorIdx: 0 }],
      [
        { function: "transfer", args: ["1", "1"], actorIdx: 0 },
        { function: "big", args: Array.from({ length: 10 }, () => "2"), actorIdx: 1 },
      ],
    ],
  };
  const r = okVal(generateTestProject(INPUT, plan, ABI, { forgeStdDir: STD }));
  const handler = file(r.files, "test/handler/DifferentialHandler.sol");

  it("generates no handler function and no selector entry, but keeps the selector known", () => {
    expect(r.skippedFunctions).toEqual([{ name: "big", reason: "stack" }]);
    expect(handler).not.toContain("handler_big");
    expect(handler).toContain("handler_ok");
    expect(file(r.files, "test/Seance.t.sol")).not.toContain("handler_big");
    expect(file(r.files, "test/Witness.t.sol")).not.toContain("handler_big");
    const targets = file(r.files, "test/handler/Targets.sol");
    expect(targets).not.toContain("targets_big");
    expect(targets).toContain(`keccak256("big(${Array.from({ length: 10 }, () => "uint256").join(",")})")`); // isKnownSelector
  });

  it("drops seed calls naming it and sequences that become empty", () => {
    const targets = file(r.files, "test/handler/Targets.sol");
    expect(targets).toContain("s = new Seed[](1);");
    expect(targets).toContain('fn: "transfer"');
    expect(targets).not.toContain('fn: "big"');
    expect(handler).not.toContain('keccak256("big")');
  });

  it("rejects a witness pair that names it", () => {
    const w = generateTestProject(INPUT, plan, ABI, { forgeStdDir: STD, witnessPairs: [{ function: "big", classification: "exorcised" }] });
    expect(!w.ok && w.error.code).toBe("INVALID_INPUT");
  });

  it("is INVALID_INPUT when the skip leaves nothing to fuzz, and fine when a fallback remains", () => {
    const none = generateTestProject(INPUT, EMPTY_PLAN, [BIG], { forgeStdDir: STD });
    expect(!none.ok && none.error.code).toBe("INVALID_INPUT");
    expect(!none.ok && none.error.message).toContain("stack depth");
    expect(planHandlerFunctions([BIG]).ok).toBe(false);
    const fb: AbiFunction = { type: "fallback", inputs: [], stateMutability: "payable" };
    const some = okVal(generateTestProject(INPUT, EMPTY_PLAN, [BIG, fb], { forgeStdDir: STD }));
    expect(some.skippedFunctions).toEqual([{ name: "big", reason: "stack" }]);
    expect(file(some.files, "test/handler/DifferentialHandler.sol")).toContain("handler_fallback_empty");
  });

  it("an unsupported parameter type is still INVALID_INPUT, even on a function that would be skipped", () => {
    const bad: AbiFunction = { ...fn("bad", "u".repeat(12)), inputs: [...fn("bad", "u".repeat(12)).inputs, { name: "z", type: "uint256[][]" }] };
    const r2 = generateTestProject(INPUT, EMPTY_PLAN, [OK, bad], { forgeStdDir: STD });
    expect(!r2.ok && r2.error.code).toBe("INVALID_INPUT");
  });

  it("generateProject is the sorted union of generateSrcProject and generateTestProject", () => {
    const opts = { forgeStdDir: STD, fundingWei: 5n };
    const src = okVal(generateSrcProject(INPUT, opts));
    const test = okVal(generateTestProject(INPUT, plan, ABI, opts));
    const all = okVal(generateProject(INPUT, plan, ABI, opts));
    expect(src.map((f) => f.path)).toEqual(["foundry.toml", "remappings.txt", "src/legacy/LegacyT.sol", "src/port/PortT.sol"]);
    expect(test.files.every((f) => f.path.startsWith("test/"))).toBe(true);
    expect(all.files).toEqual([...src, ...test.files].sort((a, b) => (a.path < b.path ? -1 : 1)));
    expect(all.skippedFunctions).toEqual(test.skippedFunctions);
    expect(file(test.files, "test/handler/Targets.sol")).toContain("FUNDING_WEI = 5;");
    expect(okVal(generateTestProject(INPUT, plan, ABI, opts))).toEqual(test); // deterministic
  });
});

describe("generateTargets with a skipped set", () => {
  const abi: AbiFunction[] = [TRANSFER, fn("big", "u".repeat(10))];
  const report = (precondition: string) => {
    const site = (id: string, f: string, op: string) => ({
      id,
      function: f,
      operator: "*",
      operands: [{ kind: "param", name: op, type: "uint256" }, { kind: "param", name: op, type: "uint256" }],
      location: { file: "L.sol", line: 1, column: 1 },
      ...(precondition ? { precondition: [{ kind: precondition }] } : {}),
    });
    const r = parseAutopsyReport(
      JSON.stringify({ schemaVersion: "1", contract: "T", sites: [site("s1", "transfer", "_value"), site("s2", "big", "x0")] }),
      abi,
    );
    return okVal(r);
  };

  it("marks sites in a skipped function unreachable and still gives them entries", () => {
    const plain = okVal(generateTargets(report(""), abi));
    expect(plain.sites.map((s) => s.unreachable)).toEqual([false, false]);
    const skipped = okVal(generateTargets(report(""), abi, new Set(["big"])));
    expect(skipped.sites.map((s) => s.unreachable)).toEqual([false, true]);
    expect(skipped.sites[1]!.entries.length).toBeGreaterThanOrEqual(1);
    expect(skipped.sites[1]!.entries).toEqual(plain.sites[1]!.entries);
  });

  it("drops seed calls naming a skipped function, so the site that needed it is unreachable", () => {
    const plain = okVal(generateTargets(report("transfer"), abi));
    expect(plain.seedSequences.length).toBeGreaterThan(0);
    const skipped = okVal(generateTargets(report("transfer"), abi, new Set(["transfer"])));
    expect(skipped.seedSequences.flat().some((c) => c.function === "transfer")).toBe(false);
    expect(skipped.sites.every((s) => s.unreachable)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeProjectFiles
// ---------------------------------------------------------------------------

describe("writeProjectFiles", () => {
  const src = okVal(generateSrcProject(INPUT, { forgeStdDir: STD }));
  const test = okVal(generateTestProject(INPUT, EMPTY_PLAN, [OK], { forgeStdDir: STD })).files;

  it("writes the src stage fresh, then the test stage into the same directory", () => {
    const dir = join(tmp(), "p");
    expect(writeProjectFiles(dir, src, { mode: "fresh" }).ok).toBe(true);
    expect(existsSync(join(dir, "test"))).toBe(false);
    const add = writeProjectFiles(dir, test, { mode: "add" });
    expect(add.ok, add.ok ? "" : add.error.message).toBe(true);
    for (const f of [...src, ...test]) expect(readFileSync(join(dir, f.path), "utf8")).toBe(f.contents);
  });

  it("keeps the fresh guard: a non-empty directory is refused in fresh mode", () => {
    const dir = join(tmp(), "p");
    expect(writeProjectFiles(dir, src, { mode: "fresh" }).ok).toBe(true);
    const again = writeProjectFiles(dir, src, { mode: "fresh" });
    expect(!again.ok && again.error.message).toContain("not empty");
  });

  it("add mode never overwrites, and writes nothing when one file collides", () => {
    const dir = join(tmp(), "p");
    writeProjectFiles(dir, src, { mode: "fresh" });
    expect(writeProjectFiles(dir, test, { mode: "add" }).ok).toBe(true);
    const again = writeProjectFiles(dir, [{ path: "test/Seance.t.sol", contents: "changed" }, { path: "test/zzz2.sol", contents: "y" }], { mode: "add" });
    expect(!again.ok && again.error.code).toBe("INVALID_INPUT");
    expect(readFileSync(join(dir, "test/Seance.t.sol"), "utf8")).toBe(file(test, "test/Seance.t.sol"));
    expect(existsSync(join(dir, "test/zzz2.sol"))).toBe(false);
    const overSrc = writeProjectFiles(dir, [{ path: "foundry.toml", contents: "x" }], { mode: "add" });
    expect(overSrc.ok).toBe(false);
  });

  it("add mode needs an existing directory", () => {
    const dir = join(tmp(), "missing");
    const r = writeProjectFiles(dir, test, { mode: "add" });
    expect(!r.ok && r.error.code).toBe("INVALID_INPUT");
    expect(existsSync(dir)).toBe(false);
  });

  it("rejects escaping, unsorted, duplicate and lib/ paths in both modes", () => {
    const dir = tmp();
    const cases: ProjectFiles[] = [
      [{ path: "../escape.sol", contents: "x" }],
      [{ path: "a/../../escape.sol", contents: "x" }],
      [{ path: "/abs.sol", contents: "x" }],
      [{ path: "lib/forge-std/Test.sol", contents: "x" }],
      [{ path: "b.sol", contents: "x" }, { path: "a.sol", contents: "x" }],
      [{ path: "a.sol", contents: "x" }, { path: "a.sol", contents: "x" }],
    ];
    for (const c of cases) {
      for (const mode of ["fresh", "add"] as const) {
        expect(writeProjectFiles(dir, c, { mode }).ok, JSON.stringify(c)).toBe(false);
      }
    }
    expect(existsSync(join(dir, "a.sol"))).toBe(false);
  });

  it("add mode refuses to write through a symlink that leaves the directory", () => {
    const outside = tmp();
    const dir = tmp();
    symlinkSync(outside, join(dir, "test"));
    const r = writeProjectFiles(dir, [{ path: "test/A.sol", contents: "x" }], { mode: "add" });
    expect(r.ok).toBe(false);
    expect(existsSync(join(outside, "A.sol"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// forge
// ---------------------------------------------------------------------------

function buildOnDisk(abi: AbiFunction[], plan: TargetPlan = EMPTY_PLAN) {
  const dir = join(tmp(), "project");
  const opts = { forgeStdDir: LOCAL_STD };
  okVal(writeProjectFiles(dir, okVal(generateSrcProject(INPUT, opts)), { mode: "fresh" }));
  const t = okVal(generateTestProject(INPUT, plan, abi, opts));
  okVal(writeProjectFiles(dir, t.files, { mode: "add" }));
  const r = spawnSync("forge", ["build", "--offline"], { cwd: dir, encoding: "utf8", timeout: FORGE_TIMEOUT, maxBuffer: 64 * 1024 * 1024 });
  return { dir, t, status: r.status, output: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe.skipIf(skipReason !== "")(`stack limit on forge (${skipReason || "native forge 1.5.1"})`, () => {
  const T = 600_000;

  it(
    "the largest allowed signature compiles, in the stage-by-stage flow",
    () => {
      const b = buildOnDisk([fn("largest", LARGEST), OK]);
      expect(b.status, b.output.slice(0, 600)).toBe(0);
      expect(b.t.skippedFunctions).toEqual([]);
      expect(file(b.t.files, "test/handler/DifferentialHandler.sol")).toContain("function handler_largest(");
    },
    T,
  );

  it(
    "one parameter more is skipped: not generated, project compiles, sites unreachable, seeds do not call it",
    () => {
      const abi = [fn("largest", SMALLEST_SKIPPED), OK, TRANSFER];
      const rep = okVal(
        parseAutopsyReport(
          JSON.stringify({
            schemaVersion: "1",
            contract: "T",
            sites: [
              {
                id: "largest:x3*x5",
                function: "largest",
                operator: "*",
                operands: [{ kind: "param", name: "x3", type: "uint16" }, { kind: "param", name: "x5", type: "uint256" }],
                location: { file: "L.sol", line: 1, column: 1 },
              },
            ],
          }),
          abi,
        ),
      );
      const skipped = new Set(computeSkippedFunctions(abi).map((s) => s.name));
      expect([...skipped]).toEqual(["largest"]);
      const plan = okVal(generateTargets(rep, abi, skipped));
      expect(plan.sites.map((s) => [s.functionName, s.unreachable])).toEqual([["largest", true]]);
      const withSeeds: TargetPlan = {
        ...plan,
        seedSequences: [[{ function: "largest", args: ["1", "2", "3", "4"], actorIdx: 0 }, { function: "transfer", args: ["1", "1"], actorIdx: 0 }]],
      };
      const b = buildOnDisk(abi, withSeeds);
      expect(b.status, b.output.slice(0, 600)).toBe(0);
      expect(b.t.skippedFunctions).toEqual([{ name: "largest", reason: "stack" }]);
      const handler = file(b.t.files, "test/handler/DifferentialHandler.sol");
      expect(handler).not.toContain("handler_largest");
      expect(file(b.t.files, "test/handler/Targets.sol")).not.toContain('fn: "largest"');
    },
    T,
  );

  it(
    "the earlier two(bytes,string,address[],uint16[],bytes32[]) case is skipped instead of failing the build",
    () => {
      const two: AbiFunction = {
        type: "function",
        name: "two",
        inputs: [
          { name: "e", type: "bytes" }, { name: "f", type: "string" }, { name: "g", type: "address[]" },
          { name: "h", type: "uint16[]" }, { name: "j", type: "bytes32[]" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
      };
      expect(estimateHandlerStack(two)).toBeGreaterThan(MAX_HANDLER_STACK);
      const b = buildOnDisk([two, OK]);
      expect(b.status, b.output.slice(0, 600)).toBe(0);
      expect(b.t.skippedFunctions).toEqual([{ name: "two", reason: "stack" }]);
    },
    T,
  );

  it(
    "mixed signatures on the boundary: every accepted one compiles, every rejected one is skipped and the project still builds",
    () => {
      const accepted = ["AuuuBb", "SuaAn", "uuuuuuuuu", "UAUbbb".slice(0, 3), "BBBB"].filter((c) => estimateHandlerStack(fn("f", c)) <= MAX_HANDLER_STACK);
      const rejected = ["uuuuuuuuuu", "AAAA", "BBBBB", "SBAUa"];
      const abi = [...accepted.map((c, i) => fn(`acc${i}`, c)), ...rejected.map((c, i) => fn(`rej${i}`, c, i % 2 ? "payable" : "nonpayable"))];
      expect(computeSkippedFunctions(abi).map((s) => s.name)).toEqual(rejected.map((_, i) => `rej${i}`));
      const b = buildOnDisk(abi);
      expect(b.status, b.output.slice(0, 600)).toBe(0);
      const handler = file(b.t.files, "test/handler/DifferentialHandler.sol");
      for (let i = 0; i < accepted.length; i++) expect(handler).toContain(`function handler_acc${i}(`);
      for (let i = 0; i < rejected.length; i++) expect(handler).not.toContain(`handler_rej${i}`);
    },
    T,
  );
});
