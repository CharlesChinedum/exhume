/**
 * Task 8.5: Project_Generator. Static tests (no forge) check the generated text against the hand-written
 * fixtures of tasks 8.3/8.4, determinism, layout, writing and the replay decoder. Forge tests (skipped when
 * forge or the local forge-std checkout is missing) build and run the generated token, wallet and
 * parameter-type projects natively.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { loadAbi } from "../../src/seance/abi.js";
import { parseAutopsyReport } from "../../src/seance/autopsy-contract.js";
import { generateTargets } from "../../src/seance/input-generator.js";
import { INVARIANT_DEPTH, INVARIANT_RUNS } from "../../src/seance/forge-std-pin.js";
import { keccak256Utf8, selectorOf } from "../../src/seance/keccak.js";
import {
  generateAndWriteProject,
  generateProject,
  planHandlerFunctions,
  regenerateReplay,
  regenerateWitness,
  templatesDir,
  validateProjectFiles,
  writeProject,
  type GeneratorOptions,
  type ProjectFiles,
} from "../../src/seance/project-generator.js";
import { verifyTaint } from "../../src/seance/taint.js";
import type { AbiFunction, RecordLine, SeanceInput, TargetPlan } from "../../src/seance/types.js";
import {
  DOCKER_TOKEN,
  FORGE_TIMEOUT,
  LOCAL_STD,
  WALLET_FIXTURE,
  TOKEN_FIXTURE,
  parseCx,
  read,
  skipReason,
} from "./template-project.js";

// ---------------------------------------------------------------------------
// Fixtures: token (docker fixture), wallet (handler-wallet), types
// ---------------------------------------------------------------------------

const abiOf = (raw: unknown[]): AbiFunction[] => {
  const r = loadAbi(raw);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

const TOKEN_ABI = abiOf([
  { constant: true, inputs: [{ name: "_owner", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], payable: false, type: "function" },
  { constant: false, inputs: [{ name: "_to", type: "address" }, { name: "_value", type: "uint256" }], name: "transfer", outputs: [{ name: "", type: "bool" }], payable: false, type: "function" },
  { constant: false, inputs: [{ name: "_receivers", type: "address[]" }, { name: "_value", type: "uint256" }], name: "batchTransfer", outputs: [{ name: "", type: "bool" }], payable: false, type: "function" },
  { inputs: [], payable: false, type: "constructor" },
]);

const TOKEN_AUTOPSY = JSON.stringify({
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
      location: { file: "LegacyToken.sol", line: 20, column: 30 },
      precondition: [{ kind: "transfer" }],
    },
  ],
});

const tokenInput = (over: Partial<SeanceInput> = {}): SeanceInput => ({
  contractName: "Token",
  legacySource: read(join(DOCKER_TOKEN, "src/legacy/LegacyToken.sol")),
  portSource: read(join(DOCKER_TOKEN, "src/port/PortToken.sol")),
  autopsyReport: TOKEN_AUTOPSY,
  legacySolcVersion: "0.4.19",
  legacyOptimizer: false,
  onChainRuntimeCode: "0x6060604052",
  ...over,
});

function planFor(input: SeanceInput, abi: AbiFunction[]): TargetPlan {
  const rep = parseAutopsyReport(input.autopsyReport, abi);
  if (!rep.ok) throw new Error(rep.error.message);
  const plan = generateTargets(rep.value, abi);
  if (!plan.ok) throw new Error(plan.error.message);
  return plan.value;
}

const STD = "/opt/forge-std";
function gen(input: SeanceInput, abi: AbiFunction[], plan: TargetPlan, opts: GeneratorOptions = {}): ProjectFiles {
  const r = generateProject(input, plan, abi, opts);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
const file = (p: ProjectFiles, path: string): string => {
  const f = p.find((x) => x.path === path);
  if (!f) throw new Error(`no ${path}`);
  return f.contents;
};

const WITNESS_PAIRS = [
  { function: "batchTransfer", classification: "exorcised" as const },
  { function: "transfer", classification: "port-bug" as const },
];
const tokenProject = (opts: GeneratorOptions = {}): ProjectFiles => {
  const input = tokenInput();
  return gen(input, TOKEN_ABI, planFor(input, TOKEN_ABI), { forgeStdDir: STD, ...opts });
};

const WALLET_ABI = abiOf([
  { constant: true, inputs: [], name: "total", outputs: [{ name: "", type: "uint256" }], payable: false, stateMutability: "view", type: "function" },
  { constant: true, inputs: [], name: "hits", outputs: [{ name: "", type: "uint256" }], payable: false, stateMutability: "view", type: "function" },
  { constant: true, inputs: [], name: "lastSenderBalance", outputs: [{ name: "", type: "uint256" }], payable: false, stateMutability: "view", type: "function" },
  { constant: true, inputs: [{ name: "", type: "address" }], name: "deposits", outputs: [{ name: "", type: "uint256" }], payable: false, stateMutability: "view", type: "function" },
  { constant: true, inputs: [{ name: "", type: "address" }, { name: "", type: "address" }], name: "allowed", outputs: [{ name: "", type: "uint256" }], payable: false, stateMutability: "view", type: "function" },
  { constant: false, inputs: [], name: "deposit", outputs: [], payable: true, stateMutability: "payable", type: "function" },
  { constant: false, inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], name: "approve", outputs: [{ name: "", type: "bool" }], payable: false, stateMutability: "nonpayable", type: "function" },
  { constant: false, inputs: [], name: "crash", outputs: [], payable: false, stateMutability: "nonpayable", type: "function" },
  { inputs: [{ name: "x", type: "uint256" }], payable: false, stateMutability: "nonpayable", type: "constructor" },
  { payable: true, stateMutability: "payable", type: "fallback" },
]);
const walletInput = (): SeanceInput => ({
  contractName: "Wallet",
  legacySource: read(join(WALLET_FIXTURE, "LegacyWallet.sol")),
  portSource: read(join(WALLET_FIXTURE, "PortWallet.sol")),
  autopsyReport: JSON.stringify({ schemaVersion: "1", contract: "Wallet", sites: [] }),
  legacySolcVersion: "0.4.19",
  legacyOptimizer: false,
  onChainRuntimeCode: "0x6060604052",
  constructorArgs: "0x" + "0".repeat(63) + "1",
});
const WALLET_PLAN: TargetPlan = {
  sites: [],
  seedSequences: [[{ function: "approve", args: ["4", "7"], actorIdx: 1 }]],
};
const walletProject = (): ProjectFiles =>
  gen(walletInput(), WALLET_ABI, WALLET_PLAN, { forgeStdDir: STD, fundingWei: 10n ** 18n });

const TYPES_LEGACY = `pragma solidity ^0.4.19;
contract Types {
    uint256 public total;
    function one(uint8 a, int16 b, bool c, bytes4 d, address i, int256 k) public returns (uint256) {
        total += uint256(a) + (c ? 1 : 0);
        if (i != address(0)) { total += 1; }
        return total;
    }
    function two(bytes e, string f, address[] g) public returns (uint256) {
        total += g.length + e.length + bytes(f).length;
        return total;
    }
    function three(uint16[] h, bytes32[] j) public returns (uint256) {
        total += h.length + j.length;
        return total;
    }
}
`;
const TYPES_PORT = `// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;
contract Types {
    uint256 public total;
    function one(uint8 a, int16 b, bool c, bytes4 d, address i, int256 k) public returns (uint256) {
        b; d; k;
        total += uint256(a) + (c ? 1 : 0);
        if (i != address(0)) { total += 1; }
        return total;
    }
    function two(bytes memory e, string memory f, address[] memory g) public returns (uint256) {
        total += g.length + e.length + bytes(f).length;
        return total;
    }
    function three(uint16[] memory h, bytes32[] memory j) public returns (uint256) {
        total += h.length + j.length;
        return total;
    }
}
`;
const TYPES_ABI = abiOf([
  { constant: true, inputs: [], name: "total", outputs: [{ name: "", type: "uint256" }], payable: false, stateMutability: "view", type: "function" },
  {
    constant: false,
    inputs: [
      { name: "a", type: "uint8" }, { name: "b", type: "int16" }, { name: "c", type: "bool" }, { name: "d", type: "bytes4" },
      { name: "i", type: "address" }, { name: "k", type: "int256" },
    ],
    name: "one",
    outputs: [{ name: "", type: "uint256" }],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    constant: false,
    inputs: [
      { name: "e", type: "bytes" }, { name: "f", type: "string" }, { name: "g", type: "address[]" },
    ],
    name: "two",
    outputs: [{ name: "", type: "uint256" }],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    constant: false,
    inputs: [{ name: "h", type: "uint16[]" }, { name: "j", type: "bytes32[]" }],
    name: "three",
    outputs: [{ name: "", type: "uint256" }],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
  },
]);
const typesInput = (): SeanceInput => ({
  contractName: "Types",
  legacySource: TYPES_LEGACY,
  portSource: TYPES_PORT,
  autopsyReport: JSON.stringify({ schemaVersion: "1", contract: "Types", sites: [] }),
  legacySolcVersion: "0.4.19",
  legacyOptimizer: false,
  onChainRuntimeCode: "0x6060604052",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drops comment-only and blank lines and trailing whitespace: the fixtures carry explanatory comments. */
const norm = (s: string): string =>
  s
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("//"))
    .join("\n");

const lib = (p: ProjectFiles) => p.map((f) => f.path);
const tmp = (): string => mkdtempSync(join(tmpdir(), "exhume-pg-"));

function writeTo(project: ProjectFiles): string {
  const dir = join(tmp(), "project");
  const w = writeProject(dir, project);
  if (!w.ok) throw new Error(w.error.message);
  return dir;
}

interface Forge {
  status: number | null;
  output: string;
  json?: unknown;
}
function forge(dir: string, sub: "build" | "test", args: string[] = [], env: Record<string, string> = {}): Forge {
  const r = spawnSync("forge", [sub, "--offline", ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: FORGE_TIMEOUT,
    maxBuffer: 256 * 1024 * 1024,
  });
  const stdout = r.stdout ?? "";
  let json: unknown;
  if (args.includes("--json")) {
    try {
      json = JSON.parse(stdout);
    } catch {
      json = undefined;
    }
  }
  return { status: r.status, output: stdout + (r.stderr ?? ""), json };
}

const records = (dir: string, rel: string): RecordLine[] => {
  const f = join(dir, rel);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as RecordLine);
};

const SEED = ["--fuzz-seed", "42"];
const SMALL = { FOUNDRY_INVARIANT_RUNS: "24", FOUNDRY_INVARIANT_DEPTH: "12" };

// ---------------------------------------------------------------------------
// keccak
// ---------------------------------------------------------------------------

describe("keccak256", () => {
  it("matches known Ethereum vectors", () => {
    expect(keccak256Utf8("")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(keccak256Utf8("abc")).toBe("0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
    expect(selectorOf("transfer(address,uint256)")).toBe("0xa9059cbb");
    expect(selectorOf("balanceOf(address)")).toBe("0x70a08231");
  });
  it("handles inputs around the 136-byte rate boundary", () => {
    // known: keccak256 of 135, 136 and 137 'a' bytes differ and are 32 bytes
    const hs = [135, 136, 137].map((n) => keccak256Utf8("a".repeat(n)));
    expect(new Set(hs).size).toBe(3);
    expect(keccak256Utf8("a".repeat(200))).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Generated text vs the hand-written fixtures
// ---------------------------------------------------------------------------

describe("generated token project vs the hand-written fixtures", () => {
  const p = tokenProject({ witnessPairs: WITNESS_PAIRS });
  const handler = file(p, "test/handler/DifferentialHandler.sol");

  it("handler functions equal handler-functions.part.sol (modulo comments)", () => {
    const fx = norm(read(join(TOKEN_FIXTURE, "handler-functions.part.sol")));
    expect(norm(handler)).toContain(fx);
  });

  it("seed encoder equals seed-encoder.part.sol (modulo comments)", () => {
    const fx = norm(read(join(TOKEN_FIXTURE, "seed-encoder.part.sol")));
    expect(norm(handler)).toContain(fx);
  });

  it("handler selectors and witness pairs equal the fixture parts (modulo comments)", () => {
    const sels = norm(read(join(TOKEN_FIXTURE, "handler-selectors.part.sol")));
    expect(norm(file(p, "test/Seance.t.sol"))).toContain(sels);
    expect(norm(file(p, "test/Witness.t.sol"))).toContain(sels);
    expect(norm(file(p, "test/Witness.t.sol"))).toContain(norm(read(join(TOKEN_FIXTURE, "witness-pairs.part.sol"))));
  });

  it("Targets.sol: constants, getters, selectors and the 23 generated batchTransfer entries match the fixture", () => {
    const g = file(p, "test/handler/Targets.sol");
    const fx = read(join(TOKEN_FIXTURE, "Targets.sol"));
    const section = (src: string, fn: string): string => {
      const i = src.indexOf(`function ${fn}(`);
      return norm(src.slice(i, src.indexOf("\n    }\n", i) + 7));
    };
    for (const fn of ["ctorArgs", "noArgGetters", "addrGetters", "pairGetters", "targets_transfer"]) {
      expect(section(g, fn), fn).toBe(section(fx, fn));
    }
    // isKnownSelector lists the same signatures; the generator uses ABI order, the fixture its own order
    const sigsOf = (src: string): string[] => [...section(src, "isKnownSelector").matchAll(/keccak256\("([^"]+)"\)/g)].map((m) => m[1]!).sort();
    expect(sigsOf(g)).toEqual(sigsOf(fx));
    // The hand-written fixture ends with one extra, hand-chosen entry (length 2^200, value 1) that exercises the
    // handler's clamp; the generator emits only what the TargetPlan holds (n = 2..24).
    const nums = (s: string): string[] =>
      [...s.matchAll(/_(?:pair|entry2)\((\d+), KIND_ARRAY_LEN, (\d+), (\d+), KIND_STATIC, (\d+)\)/g)].map((m) => m.slice(1).join(","));
    const gen23 = nums(section(g, "targets_batchTransfer"));
    const fx24 = nums(section(fx, "targets_batchTransfer"));
    expect(gen23).toHaveLength(23);
    expect(fx24).toHaveLength(24);
    expect(gen23).toEqual(fx24.slice(0, 23));
    // constants
    for (const c of [
      'LEGACY_ARTIFACT = "LegacyToken.sol:Token"',
      'PORT_ARTIFACT = "PortToken.sol:Token"',
      "HAS_TOKEN_SHARES = true",
      "FUNDING_WEI = 0",
      "KIND_STATIC = 0",
      "KIND_ARRAY_LEN = 1",
    ]) {
      expect(g).toContain(c);
      expect(fx).toContain(c);
    }
    // seeds: three transfers of 1 to Actor_Set indices 1..3, sender 0
    expect(g.match(/s\[\d\] = Seed\(\{fn: "transfer", actorIdx: 0, value: 0, args: a\}\);/g)).toHaveLength(3);
    expect([...g.matchAll(/a\[0\] = (\d+);/g)].map((m) => m[1])).toEqual(["1", "2", "3"]);
  });

  it("the token project lists the expected files and the generated text has no markers left except replay's", () => {
    expect(lib(p)).toEqual([
      "foundry.toml",
      "remappings.txt",
      "src/legacy/LegacyToken.sol",
      "src/port/PortToken.sol",
      "test/Replay.t.sol",
      "test/Seance.t.sol",
      "test/Witness.t.sol",
      "test/handler/Classifier.sol",
      "test/handler/DifferentialHandler.sol",
      "test/handler/Targets.sol",
    ]);
    for (const f of p) {
      const markers = f.contents.match(/^[ \t]*\/\/ @@[A-Z_0-9]+@@[ \t]*$/gm) ?? [];
      if (f.path === "test/Replay.t.sol") expect(markers).toHaveLength(10);
      else expect(markers, f.path).toEqual([]);
    }
  });
});

describe("generated wallet project vs the hand-written fixtures", () => {
  const p = walletProject();
  const handler = file(p, "test/handler/DifferentialHandler.sol");

  it("handler functions, seed encoder and selectors equal the fixture parts (modulo comments)", () => {
    expect(norm(handler)).toContain(norm(read(join(WALLET_FIXTURE, "handler-functions.part.sol"))));
    expect(norm(handler)).toContain(norm(read(join(WALLET_FIXTURE, "seed-encoder.part.sol"))));
    expect(norm(file(p, "test/Seance.t.sol"))).toContain(norm(read(join(WALLET_FIXTURE, "handler-selectors.part.sol"))));
  });

  it("Targets.sol sections equal the fixture except the seed layout (modulo comments)", () => {
    const g = file(p, "test/handler/Targets.sol");
    const fx = read(join(WALLET_FIXTURE, "Targets.sol"));
    const section = (src: string, fn: string): string => {
      const i = src.indexOf(`function ${fn}(`);
      return norm(src.slice(i, src.indexOf("\n    }", i) + 6));
    };
    for (const fn of ["noArgGetters", "addrGetters", "pairGetters", "targets_deposit", "targets_approve"]) {
      expect(section(g, fn), fn).toBe(section(fx, fn));
    }
    // The fixture writes the constructor argument as abi.encode(uint256(1)), the generator as the bytes of the input.
    expect(section(g, "ctorArgs")).toContain(`return hex"${"0".repeat(63)}1";`);
    const sigsOf = (src: string): string[] => [...section(src, "isKnownSelector").matchAll(/keccak256\("([^"]+)"\)/g)].map((m) => m[1]!).sort();
    expect(sigsOf(g)).toEqual(sigsOf(fx));
    for (const c of ["HAS_TOKEN_SHARES = false", "FUNDING_WEI = 1000000000000000000", 'LEGACY_ARTIFACT = "LegacyWallet.sol:Wallet"']) {
      expect(g).toContain(c);
    }
    expect(g).toContain('s[0] = Seed({fn: "approve", actorIdx: 1, value: 0, args: a});');
  });
});

describe("handler parameter mapping", () => {
  it("maps every supported type per the design table", () => {
    const r = planHandlerFunctions(TYPES_ABI);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const one = r.value.find((h) => h.recordName === "one")!;
    // pick, actorIdx, a, b, c, d (uint256 each), i (uint8 actor index), k
    expect(one.paramTypes).toEqual(["uint256", "uint8", "uint256", "uint256", "uint256", "uint256", "uint8", "uint256"]);
    expect(one.source).toContain('abi.encodeWithSignature("one(uint8,int16,bool,bytes4,address,int256)"');
    expect(one.source).toContain("uint8(p[0])");
    expect(one.source).toContain("int16(uint16(p[1]))");
    expect(one.source).toContain("(p[2] & 1) == 1");
    expect(one.source).toContain("bytes4(bytes32(p[3]))");
    expect(one.source).toContain("_addr(i)");
    expect(one.source).toContain("int256(p[5])");
    const two = r.value.find((h) => h.recordName === "two")!;
    // bytes and string: one `bytes`; address[]: len + idxPack; other arrays: len + seed
    expect(two.paramTypes).toEqual(["uint256", "uint8", "bytes", "bytes", "uint8", "uint256"]);
    expect(two.source).toContain('abi.encodeWithSignature("two(bytes,string,address[])"');
    expect(two.source).toContain("string(f)");
    expect(two.source).toContain("_addressArray(p[2], g_idxPack)");
    const three = r.value.find((h) => h.recordName === "three")!;
    expect(three.paramTypes).toEqual(["uint256", "uint8", "uint8", "uint256", "uint8", "uint256"]);
    expect(three.source).toContain("_elemSeed(h_seed, j)");
    expect(three.source).toContain("bytes32[] memory j_ = new bytes32[](_boundLen(p[1]));"); // `j` is a reserved name
  });

  it.each([
    ["a tuple", { name: "t", type: "tuple", components: [{ name: "x", type: "uint256" }] }, "tuple"],
    ["a fixed-size array", { name: "x", type: "uint256[2]" }, "uint256[2]"],
    ["a nested array", { name: "x", type: "uint256[][]" }, "uint256[][]"],
    ["a string array", { name: "x", type: "string[]" }, "string[]"],
  ])("rejects %s, naming the function and parameter", (_n, param, type) => {
    const abi = abiOf([{ type: "function", name: "f", inputs: [param], outputs: [], stateMutability: "nonpayable" }]);
    const r = planHandlerFunctions(abi);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.message).toContain("function f");
    expect(r.error.message).toContain(JSON.stringify(param.name));
    expect(r.error.details).toMatchObject({ function: "f", parameter: param.name, type });
  });

  it("rejects overloaded state-changing functions and ABIs with nothing to fuzz", () => {
    const over = abiOf([
      { type: "function", name: "f", inputs: [], outputs: [], stateMutability: "nonpayable" },
      { type: "function", name: "f", inputs: [{ name: "x", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
    ]);
    const a = planHandlerFunctions(over);
    expect(!a.ok && a.error.message).toContain("overloaded");
    const none = abiOf([{ type: "function", name: "v", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" }]);
    expect(planHandlerFunctions(none).ok).toBe(false);
  });

  it("emits handler_fallback_empty for receive, plus handler_fallback_unknown only for a fallback", () => {
    const rx = planHandlerFunctions(abiOf([{ type: "receive", stateMutability: "payable" }]));
    expect(rx.ok && rx.value.map((h) => h.name)).toEqual(["handler_fallback_empty"]);
    const fb = planHandlerFunctions(abiOf([{ type: "fallback", stateMutability: "nonpayable" }]));
    expect(fb.ok && fb.value.map((h) => h.name)).toEqual(["handler_fallback_empty", "handler_fallback_unknown"]);
    expect(fb.ok && fb.value[0]!.paramTypes).toEqual(["uint256", "uint8"]);
  });
});

// ---------------------------------------------------------------------------
// Determinism, layout, validation
// ---------------------------------------------------------------------------

describe("generateProject: determinism and layout", () => {
  it("is byte-identical across runs, sorted, LF-only, with no lib/ and no local path", () => {
    const a = gen(tokenInput(), TOKEN_ABI, planFor(tokenInput(), TOKEN_ABI), { forgeStdDir: LOCAL_STD });
    const b = gen(tokenInput(), TOKEN_ABI, planFor(tokenInput(), TOKEN_ABI), { forgeStdDir: LOCAL_STD });
    expect(b).toEqual(a);
    const paths = lib(a);
    expect([...paths].sort()).toEqual(paths);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.some((x) => x === "lib" || x.startsWith("lib/"))).toBe(false);
    expect(paths.some((x) => x.includes(LOCAL_STD))).toBe(false);
    for (const f of a) {
      if (!f.path.startsWith("src/")) expect(f.contents, f.path).not.toContain("\r");
      expect(f.contents.split(LOCAL_STD).join("<STD>")).not.toMatch(/\/Users\/|\/home\//); // only the forgeStdDir option may be a machine path
    }
    expect(validateProjectFiles(a).ok).toBe(true);
  });

  it("changes remappings.txt, allow_paths and the forge-std restriction with forgeStdDir, and nothing else of it leaks", () => {
    const other = "/srv/other-std";
    for (const dir of [STD, other]) {
      const p = tokenProject({ forgeStdDir: dir });
      expect(file(p, "remappings.txt")).toBe(`forge-std/=${dir}/src/\n`);
      const toml = file(p, "foundry.toml");
      expect(toml).toContain(`allow_paths = ["${dir}"]`);
      expect(toml).toContain(`{ paths = "${dir}/src/**", version = "=0.8.28" }`);
      const not = dir === STD ? other : STD;
      for (const f of p) expect(f.contents, f.path).not.toContain(not);
    }
  });

  it("copies both sources unchanged, pins the legacy version exactly and uses the artifact names", () => {
    const input = tokenInput();
    const p = gen(input, TOKEN_ABI, planFor(input, TOKEN_ABI));
    expect(file(p, "src/legacy/LegacyToken.sol")).toBe(input.legacySource);
    expect(file(p, "src/port/PortToken.sol")).toBe(input.portSource);
    expect(file(p, "foundry.toml")).toContain('{ paths = "src/legacy/LegacyToken.sol", version = "=0.4.19" }');
    expect(file(p, "foundry.toml")).toContain('{ paths = "src/port/PortToken.sol", version = "=0.8.28" }');
    expect(file(p, "test/handler/Targets.sol")).toContain('"LegacyToken.sol:Token"');
    expect(file(p, "test/handler/Targets.sol")).toContain('"PortToken.sol:Token"');
    expect(file(p, "test/handler/Targets.sol")).toContain('return hex"";');
  });

  it("applies the legacy optimizer and portSharesLegacyOptimizer options", () => {
    const input = tokenInput({ legacyOptimizer: true, legacyOptimizerRuns: 0 });
    const p = gen(input, TOKEN_ABI, planFor(input, TOKEN_ABI), { portSharesLegacyOptimizer: true });
    const toml = file(p, "foundry.toml");
    expect(toml).toContain("min_optimizer_runs = 0, max_optimizer_runs = 0");
    expect(toml.match(/min_optimizer_runs = 0, max_optimizer_runs = 0/g)).toHaveLength(2);
    expect(toml).toContain('additional_compiler_profiles = [{ name = "legacy_opt", optimizer = true, optimizer_runs = 0 }]');
  });

  it("is a function of the plan: the seeds change Targets.sol and the seed encoder only", () => {
    const input = tokenInput();
    const a = gen(input, TOKEN_ABI, planFor(input, TOKEN_ABI));
    const plan = planFor(input, TOKEN_ABI);
    const b = gen(input, TOKEN_ABI, { ...plan, seedSequences: [] });
    const diff = a.filter((f, i) => f.contents !== b[i]!.contents).map((f) => f.path);
    expect(diff).toEqual(["test/handler/DifferentialHandler.sol", "test/handler/Targets.sol"]);
    expect(file(b, "test/handler/DifferentialHandler.sol")).toContain("        s;\n");
  });

  it("returns an error naming each bad input and produces nothing for invalid input", () => {
    const r = generateProject({ ...tokenInput(), legacySolcVersion: "0.8.0", contractName: "" }, { sites: [], seedSequences: [] }, TOKEN_ABI);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.message).toContain("contractName");
    expect(r.error.message).toContain("legacySolcVersion");
    const bad = generateProject(tokenInput(), { sites: [], seedSequences: [] }, TOKEN_ABI, { forgeStdDir: "relative/dir" });
    expect(!bad.ok && bad.error.code).toBe("INVALID_INPUT");
  });

  it("rejects seed calls and targets that cannot be encoded", () => {
    const input = tokenInput();
    const plan = planFor(input, TOKEN_ABI);
    const seeds = (s: TargetPlan["seedSequences"]) => generateProject(input, { ...plan, seedSequences: s }, TOKEN_ABI);
    expect(seeds([[{ function: "nope", args: ["1"], actorIdx: 0 }]]).ok).toBe(false);
    expect(seeds([[{ function: "transfer", args: ["1", "-5"], actorIdx: 0 }]]).ok).toBe(false);
    expect(seeds([[{ function: "transfer", args: ["1", "2"], actorIdx: 300 }]]).ok).toBe(false);
    expect(seeds([[{ function: "batchTransfer", args: ["1", "2"], actorIdx: 0 }]]).ok).toBe(false); // array parameter
    const badTarget: TargetPlan = {
      ...plan,
      sites: [{ siteId: "s", functionName: "transfer", unreachable: false, entries: [{ assignments: [{ slot: { encoding: "static", paramIndex: 7, headOffset: 0 }, value: 1n }] }] }],
    };
    expect(generateProject(input, badTarget, TOKEN_ABI).ok).toBe(false);
  });

  it("finds the packaged templates", () => {
    const dir = templatesDir();
    for (const n of ["Handler.sol", "Classifier.sol", "Seance.t.sol", "Witness.t.sol", "Replay.t.sol"]) {
      expect(existsSync(join(dir, n)), n).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// writeProject
// ---------------------------------------------------------------------------

describe("writeProject", () => {
  it("writes exactly the generated file list (no extras, no lib/) and nothing is left staged", () => {
    const base = tmp();
    const dir = join(base, "nested/new-project");
    const p = tokenProject();
    const w = writeProject(dir, p);
    expect(w.ok).toBe(true);
    const found: string[] = [];
    const walk = (d: string, rel: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const r = rel === "" ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) walk(join(d, e.name), r);
        else found.push(r);
      }
    };
    walk(dir, "");
    expect(found.sort()).toEqual(lib(p));
    for (const f of p) expect(readFileSync(join(dir, f.path), "utf8")).toBe(f.contents);
    expect(readdirSync(join(base, "nested"))).toEqual(["new-project"]);
    rmSync(base, { recursive: true, force: true });
  });

  it("generateAndWriteProject with invalid input writes nothing", () => {
    const base = tmp();
    const dir = join(base, "p");
    const r = generateAndWriteProject(dir, { ...tokenInput(), legacySolcVersion: "0.8.19" }, { sites: [], seedSequences: [] }, TOKEN_ABI);
    expect(r.ok).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(base)).toEqual([]);
    rmSync(base, { recursive: true, force: true });
  });

  it("validates the file list before touching the disk", () => {
    const base = tmp();
    const dir = join(base, "p");
    const good = tokenProject();
    const cases: ProjectFiles[] = [
      [],
      [{ path: "../escape.sol", contents: "x" }],
      [{ path: "/abs.sol", contents: "x" }],
      [{ path: "lib/forge-std/Test.sol", contents: "x" }],
      [{ path: "b.sol", contents: "x" }, { path: "a.sol", contents: "x" }],
      [{ path: "a.sol", contents: "x" }, { path: "a.sol", contents: "x" }],
      [...good, { path: "src//x.sol", contents: "" }],
    ];
    for (const c of cases) {
      expect(writeProject(dir, c).ok).toBe(false);
      expect(existsSync(dir)).toBe(false);
    }
    expect(readdirSync(base)).toEqual([]);
    rmSync(base, { recursive: true, force: true });
  });

  it("refuses a non-empty directory, accepts an existing empty one", () => {
    const base = tmp();
    expect(writeProject(base, tokenProject()).ok).toBe(true); // `base` exists and is empty
    expect(statSync(join(base, "foundry.toml")).isFile()).toBe(true);
    const again = writeProject(base, tokenProject());
    expect(again.ok).toBe(false);
    expect(!again.ok && again.error.message).toContain("not empty");
    rmSync(base, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// regenerateWitness / regenerateReplay (static)
// ---------------------------------------------------------------------------

const word = (v: bigint): string => v.toString(16).padStart(64, "0");
const callData = (sig: string, ...words: bigint[]): string => selectorOf(sig) + words.map(word).join("");
const BC = "handler_batchTransfer(uint256,uint8,uint8,uint256,uint256)";
const V255 = 1n << 255n;

describe("regenerateReplay / regenerateWitness", () => {
  const p = tokenProject();

  it("regenerates only test/Replay.t.sol and reproduces the fixture call statement", () => {
    const r = regenerateReplay(p, TOKEN_ABI, [{ k: 1, calls: [{ func_name: "handler_batchTransfer", calldata: callData(BC, 3n, 1n, 2n, 0n, V255) }] }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(lib(r.value)).toEqual(lib(p));
    expect(r.value.filter((f, i) => f.contents !== p[i]!.contents).map((f) => f.path)).toEqual(["test/Replay.t.sol"]);
    const fx = norm(read(join(TOKEN_FIXTURE, "replay-calls-1.part.sol")));
    expect(norm(file(r.value, "test/Replay.t.sol"))).toContain(fx);
    // other pairs keep their marker; the one filled is gone
    const markers = file(r.value, "test/Replay.t.sol").match(/@@REPLAY_CALLS_(\d+)@@/g)!;
    expect(markers).toHaveLength(9); // 2..10 remain in the test_replay bodies
    expect(file(r.value, "test/Replay.t.sol")).not.toMatch(/\/\/ @@REPLAY_CALLS_1@@/);
  });

  it("is a function of its arguments only: the same call twice, or from an already regenerated project", () => {
    const seq = [{ k: 2, calls: [{ func_name: "handler_transfer", calldata: callData("handler_transfer(uint256,uint8,uint8,uint256)", 5n, 0n, 4n, 9n) }] }];
    const a = regenerateReplay(p, TOKEN_ABI, seq);
    const b = a.ok ? regenerateReplay(a.value, TOKEN_ABI, seq) : a;
    expect(a).toEqual(b);
    expect(a.ok && norm(file(a.value, "test/Replay.t.sol"))).toContain("handler.handler_transfer(5, 0, 4, 9);");
  });

  it("decodes bytes arguments (fallback with an unknown selector) and a payable value", () => {
    const w = walletProject();
    const sig = "handler_fallback_unknown(uint256,uint8,bytes,uint256)";
    // pick=7, actorIdx=1, bytes at offset 0x80 = 0xdeadbeef (len 4), weiValue=9
    const cd = selectorOf(sig) + word(7n) + word(1n) + word(0x80n) + word(9n) + word(4n) + "deadbeef".padEnd(64, "0");
    const r = regenerateReplay(w, WALLET_ABI, [{ k: 3, calls: [{ func_name: "handler_fallback_unknown", calldata: cd }] }]);
    expect(r.ok && file(r.value, "test/Replay.t.sol")).toContain('handler.handler_fallback_unknown(7, 1, hex"deadbeef", 9);');
    const empty = selectorOf(sig) + word(7n) + word(1n) + word(0x80n) + word(9n) + word(0n);
    const r2 = regenerateReplay(w, WALLET_ABI, [{ k: 3, calls: [{ func_name: "handler_fallback_unknown", calldata: empty }] }]);
    expect(r2.ok && file(r2.value, "test/Replay.t.sol")).toContain('handler.handler_fallback_unknown(7, 1, hex"", 9);');
  });

  it("rejects stale or malformed sequences with SEANCE_FAILED and leaves nothing written", () => {
    const bad = (calls: { func_name: string; calldata: string }[], k = 1) => regenerateReplay(p, TOKEN_ABI, [{ k, calls }]);
    const ok1 = callData(BC, 3n, 1n, 2n, 0n, 1n);
    expect(bad([{ func_name: "handler_nope", calldata: ok1 }]).ok).toBe(false);
    expect(bad([{ func_name: "handler_transfer", calldata: ok1 }]).ok).toBe(false); // selector of another function
    expect(bad([{ func_name: "handler_batchTransfer", calldata: ok1.slice(0, -2) }]).ok).toBe(false); // truncated
    expect(bad([{ func_name: "handler_batchTransfer", calldata: callData(BC, 3n, 256n, 2n, 0n, 1n) }]).ok).toBe(false); // uint8 overflow
    expect(bad([{ func_name: "handler_batchTransfer", calldata: ok1 }], 11).ok).toBe(false);
    const dup = regenerateReplay(p, TOKEN_ABI, [{ k: 1, calls: [] }, { k: 1, calls: [] }]);
    expect(!dup.ok && dup.error.code).toBe("SEANCE_FAILED");
    expect(regenerateReplay([], TOKEN_ABI, []).ok).toBe(false); // no Replay.t.sol in the project
  });

  it("regenerateWitness replaces only test/Witness.t.sol and validates pairs", () => {
    const r = regenerateWitness(p, TOKEN_ABI, WITNESS_PAIRS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.filter((f, i) => f.contents !== p[i]!.contents).map((f) => f.path)).toEqual(["test/Witness.t.sol"]);
    expect(norm(file(r.value, "test/Witness.t.sol"))).toContain(norm(read(join(TOKEN_FIXTURE, "witness-pairs.part.sol"))));
    expect(regenerateWitness(p, TOKEN_ABI, [{ function: "balanceOf", classification: "exorcised" }]).ok).toBe(false);
    expect(regenerateWitness(p, TOKEN_ABI, Array.from({ length: 11 }, () => WITNESS_PAIRS[0]!)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Forge: build and run the generated projects natively
// ---------------------------------------------------------------------------

const word32 = (cd: string, i: number): bigint => BigInt("0x" + cd.slice(2 + 8 + 64 * i, 2 + 8 + 64 * (i + 1)));

describe.skipIf(skipReason !== "")(`generated projects on forge (${skipReason || "native forge 1.5.1"})`, () => {
  it(
    "token: builds offline with solc 0.4.19 for the legacy file, full-size discovery, witness, replay",
    () => {
      const input = tokenInput();
      const abi = TOKEN_ABI;
      const project = gen(input, abi, planFor(input, abi), { forgeStdDir: LOCAL_STD, witnessPairs: WITNESS_PAIRS });
      const dir = writeTo(project);
      try {
        const build = forge(dir, "build");
        expect(build.status, build.output.slice(-3000)).toBe(0);
        expect(existsSync(join(dir, "lib"))).toBe(false);
        // (7) the legacy file compiled with exactly 0.4.19, the port and tests with 0.8.28
        const meta = (rel: string) => JSON.parse(readFileSync(join(dir, rel), "utf8")) as { metadata: { compiler: { version: string } } };
        expect(meta("out/LegacyToken.sol/Token.json").metadata.compiler.version).toMatch(/^0\.4\.19\+/);
        expect(meta("out/PortToken.sol/Token.json").metadata.compiler.version).toMatch(/^0\.8\.28\+/);

        // (2) full-size discovery: 256 x 64, no handler revert, setup records first, exorcism, 0 port bugs
        const run = forge(dir, "test", [...SEED, "--match-contract", "^SeanceDiscovery$"]);
        expect(run.status, run.output.slice(-3000)).toBe(0);
        expect(run.output).toMatch(/invariant_discovery\(\) \(runs: 256, calls: 16384, reverts: 0\)/);
        const lines = records(dir, "seance-out/records.jsonl");
        const setup = lines.filter((l) => l.idx === -1);
        expect(lines.slice(0, setup.length).every((l) => l.idx === -1)).toBe(true);
        expect(setup.map((l) => l.function)).toEqual(["constructor", "transfer", "transfer", "transfer", "transfer", "transfer", "transfer"]);
        expect(setup.slice(1, 4).map((l) => word32(l.calldata, 0))).toEqual([0xa1n, 0xa2n, 0xa3n]);
        // sequences, replay tail, taint
        const seqs: RecordLine[][] = [];
        for (const l of lines) if (l.idx === 0) seqs.push([l]); else if (l.idx > 0) seqs[seqs.length - 1]!.push(l);
        expect(seqs).toHaveLength(INVARIANT_RUNS + 1);
        expect(seqs[INVARIANT_RUNS]).toEqual(seqs[INVARIANT_RUNS - 1]);
        expect(seqs.every((s) => s.length <= INVARIANT_DEPTH)).toBe(true);
        const v = verifyTaint(lines);
        expect(v.ok, v.ok ? "" : v.error.message).toBe(true);
        const fuzz = seqs.slice(0, INVARIANT_RUNS).flat();
        expect(lines.filter((l) => l.classification === "port-bug")).toHaveLength(0);
        const ex = fuzz.filter((l) => l.classification === "exorcised");
        expect(ex.length).toBeGreaterThan(0);
        expect(ex.every((l) => l.function === "batchTransfer")).toBe(true);

        // (6) witness for (batchTransfer, exorcised) on the generated project, then replay of its shrunk sequence
        const wit = forge(
          dir,
          "test",
          ["--json", ...SEED, "--match-contract", "^Witness1$", "--match-test", "invariant_witness"],
          { SEANCE_RECORD: "0", FOUNDRY_INVARIANT_SHRINK_RUN_LIMIT: "5000" },
        );
        const cx = parseCx(wit.json);
        expect(cx, wit.output.slice(-2000)).toBeDefined();
        expect(cx!.calls.length).toBeGreaterThan(0);
        expect(cx!.calls.every((c) => c.func_name.startsWith("handler_"))).toBe(true);
        // the pair that never occurs passes
        const never = forge(
          dir,
          "test",
          ["--json", ...SEED, "--match-contract", "^Witness2$", "--match-test", "invariant_witness"],
          { SEANCE_RECORD: "0", ...SMALL },
        );
        expect(parseCx(never.json)).toBeUndefined();

        const re = regenerateReplay(project, abi, [{ k: 1, calls: cx!.calls }]);
        expect(re.ok, re.ok ? "" : re.error.message).toBe(true);
        if (!re.ok) return;
        expect(re.value.filter((f, i) => f.contents !== project[i]!.contents).map((f) => f.path)).toEqual(["test/Replay.t.sol"]);
        writeFileSync(join(dir, "test/Replay.t.sol"), file(re.value, "test/Replay.t.sol")); // only the regenerated file
        const rep = forge(dir, "test", ["--json", ...SEED, "--match-contract", "^SeanceReplay1$"], { SEANCE_RECORD: "1" });
        expect(rep.status, rep.output.slice(-3000)).toBe(0);
        const rl = records(dir, "seance-out/replay-1.jsonl");
        expect(rl.filter((l) => l.idx === -1)).toHaveLength(setup.length);
        const fz = rl.filter((l) => l.idx >= 0);
        expect(fz).toHaveLength(cx!.calls.length);
        expect(fz[fz.length - 1]!.function).toBe("batchTransfer");
        expect(fz[fz.length - 1]!.classification).toBe("exorcised");
      } finally {
        rmSync(join(dir, ".."), { recursive: true, force: true });
      }
    },
    4 * FORGE_TIMEOUT,
  );

  it(
    "wallet: builds and runs at reduced size with no false port-bug (payable, fallbacks, getters, assert)",
    () => {
      const dir = writeTo(gen(walletInput(), WALLET_ABI, WALLET_PLAN, { forgeStdDir: LOCAL_STD, fundingWei: 10n ** 18n }));
      try {
        const run = forge(dir, "test", [...SEED, "--match-contract", "^SeanceDiscovery$"], SMALL);
        expect(run.status, run.output.slice(-3000)).toBe(0);
        expect(run.output).toMatch(/reverts: 0\)/);
        const lines = records(dir, "seance-out/records.jsonl");
        expect(lines.filter((l) => l.classification === "port-bug")).toHaveLength(0);
        expect(lines.filter((l) => l.idx === -1).map((l) => l.function)).toEqual(["constructor", "approve"]);
        const fuzz = lines.filter((l) => l.idx >= 0);
        expect(new Set(fuzz.map((l) => l.function))).toEqual(new Set(["deposit", "approve", "crash", "fallback"]));
        expect(fuzz.filter((l) => l.function === "deposit" && l.legacy.success && BigInt(l.value) > 0n).length).toBeGreaterThan(0);
        const v = verifyTaint(lines);
        expect(v.ok, v.ok ? "" : v.error.message).toBe(true);
      } finally {
        rmSync(join(dir, ".."), { recursive: true, force: true });
      }
    },
    2 * FORGE_TIMEOUT,
  );

  it(
    "all parameter types: the generated handler compiles and its calls reach the legacy function",
    () => {
      const input = typesInput();
      const dir = writeTo(gen(input, TYPES_ABI, { sites: [], seedSequences: [] }, { forgeStdDir: LOCAL_STD }));
      try {
        const run = forge(dir, "test", [...SEED, "--match-contract", "^SeanceDiscovery$"], SMALL);
        expect(run.status, run.output.slice(-3000)).toBe(0);
        expect(run.output).toMatch(/reverts: 0\)/);
        const lines = records(dir, "seance-out/records.jsonl");
        expect(lines.filter((l) => l.classification === "port-bug")).toHaveLength(0);
        for (const [fn, sig] of [
          ["one", "one(uint8,int16,bool,bytes4,address,int256)"],
          ["two", "two(bytes,string,address[])"],
          ["three", "three(uint16[],bytes32[])"],
        ] as const) {
          const calls = lines.filter((l) => l.function === fn && l.idx >= 0);
          expect(calls.length, fn).toBeGreaterThan(0);
          expect(calls.every((l) => l.selector === selectorOf(sig))).toBe(true);
          // the legacy contract decodes the calldata: a wrong encoding would revert on both sides
          expect(calls.every((l) => l.legacy.success && l.port.success), fn).toBe(true);
        }
      } finally {
        rmSync(join(dir, ".."), { recursive: true, force: true });
      }
    },
    2 * FORGE_TIMEOUT,
  );
});
