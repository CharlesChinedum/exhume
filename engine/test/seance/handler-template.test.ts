/**
 * Task 8.3: smoke-runs templates/Handler.sol natively with forge on two hand-written fixture
 * projects (what the Project_Generator, task 8.5, is expected to emit):
 *   - fixtures/handler:        the docker token fixture (transfer, balanceOf, batchTransfer)
 *   - fixtures/handler-wallet: payable function and fallback, events, address-keyed getters, assert,
 *                              constructor argument
 * The discovery test is the real templates/Seance.t.sol (task 8.4), filled with the fixtures' selector parts.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INVARIANT_DEPTH, INVARIANT_RUNS } from "../../src/seance/forge-std-pin.js";
import { verifyTaint } from "../../src/seance/taint.js";
import type { RecordLine } from "../../src/seance/types.js";
import {
  FORGE_TIMEOUT,
  TEMPLATES,
  TOKEN_FIXTURE,
  WALLET_FIXTURE,
  assemble,
  read,
  skipReason,
  type Project,
} from "./template-project.js";

interface Run {
  status: number | null;
  output: string;
  lines: RecordLine[];
  raw: string[];
}

function runForge(p: Project, args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync("forge", ["test", "--offline", "--fuzz-seed", "42", ...args], {
    cwd: p.dir,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: FORGE_TIMEOUT,
    maxBuffer: 64 * 1024 * 1024,
  });
  const file = join(p.dir, "seance-out/records.jsonl");
  const raw = existsSync(file) ? read(file).split("\n").filter((l) => l.length > 0) : [];
  return {
    status: r.status,
    output: (r.stdout ?? "") + (r.stderr ?? ""),
    raw,
    lines: raw.map((l) => JSON.parse(l) as RecordLine),
  };
}

const discovery = (p: Project, env: Record<string, string> = {}): Run =>
  runForge(p, ["--match-contract", "SeanceDiscovery"], env);

const HEX = /^0x([0-9a-f]{2})*$/;

function expectWellFormed(r: RecordLine): void {
  expect(Number.isInteger(r.idx) && r.idx >= -1).toBe(true);
  expect(typeof r.function).toBe("string");
  expect(r.selector).toMatch(/^0x([0-9a-f]{8})?$/);
  expect(r.calldata).toMatch(HEX);
  expect(r.sender).toMatch(/^0x[0-9a-fA-F]{40}$/);
  expect(r.value).toMatch(/^\d+$/);
  for (const side of [r.legacy, r.port]) {
    expect(typeof side.success).toBe("boolean");
    expect(side.data).toMatch(HEX);
    expect(Array.isArray(side.logs)).toBe(true);
    for (const l of side.logs) {
      expect(l.emitter === "SELF" || /^0x[0-9a-fA-F]{40}$/.test(l.emitter)).toBe(true);
      expect(l.data).toMatch(HEX);
      for (const t of l.topics) expect(t).toMatch(/^0x[0-9a-f]{64}$/);
    }
    expect(side.stateHash).toMatch(/^0x[0-9a-f]{64}$/);
    // stateFields only for port-bug records
    expect(side.stateFields !== undefined).toBe(r.classification === "port-bug");
  }
  expect(["match", "reason-modernised", "exorcised", "port-bug"]).toContain(r.classification);
  expect(Array.isArray(r.differingFields)).toBe(true);
  expect(r.differingFields.length > 0).toBe(r.classification === "port-bug");
  expect([...r.differingFields].sort()).toEqual(r.differingFields);
  expect(r.invalidRecord).toBe(false);
  expect(typeof r.afterDivergence).toBe("boolean");
}

/** Splits the lines into setup lines and sequences (an idx 0 line starts a sequence). */
function split(lines: RecordLine[]): { setup: RecordLine[]; seqs: RecordLine[][] } {
  const setup: RecordLine[] = [];
  const seqs: RecordLine[][] = [];
  for (const l of lines) {
    if (l.idx === -1) setup.push(l);
    else if (l.idx === 0) seqs.push([l]);
    else seqs[seqs.length - 1]!.push(l);
  }
  return { setup, seqs };
}

/** Every line must be valid; idx continuous inside a sequence; taint must agree with taint.ts. */
function expectConsistent(lines: RecordLine[]): void {
  for (const l of lines) expectWellFormed(l);
  const { setup, seqs } = split(lines);
  // setup lines come first
  expect(lines.slice(0, setup.length).every((l) => l.idx === -1)).toBe(true);
  for (const s of seqs) s.forEach((l, i) => expect(l.idx).toBe(i));
  const v = verifyTaint(lines);
  expect(v.ok, v.ok ? "" : v.error.message).toBe(true);
}

const FULL = { FOUNDRY_INVARIANT_RUNS: String(INVARIANT_RUNS), FOUNDRY_INVARIANT_DEPTH: String(INVARIANT_DEPTH) };
const SMALL = { FOUNDRY_INVARIANT_RUNS: "24", FOUNDRY_INVARIANT_DEPTH: "12" };

/** word `i` (0-based) of the arguments of a calldata hex string */
const word = (cd: string, i: number): bigint => BigInt("0x" + cd.slice(2 + 8 + 64 * i, 2 + 8 + 64 * (i + 1)));

describe("Handler.sol template (static)", () => {
  const src = read(join(TEMPLATES, "Handler.sol"));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("pins solc 0.8.28 and carries both generator markers, one per line", () => {
    expect(src).toMatch(/^pragma solidity 0\.8\.28;$/m);
    expect(src.match(/^ {4}\/\/ @@SEED_ENCODER@@$/gm)).toHaveLength(1);
    expect(src.match(/^ {4}\/\/ @@HANDLER_FUNCTIONS@@$/gm)).toHaveLength(1);
  });

  it("calls the deployments only through gas-capped low-level calls", () => {
    expect(code).toMatch(/target\.call\{value: value, gas: GAS_CAP\}\(cd\)/);
    expect(code).toMatch(/GAS_CAP = 10_000_000/);
    expect(code).toMatch(/ACTOR_WEI = 10_000 ether/);
    // every .call/.staticcall carries a gas cap
    for (const m of code.matchAll(/\.(call|staticcall)\b[^;]*;/g)) expect(m[0]).toContain("gas: GAS_CAP");
    // no typed external call into a deployment
    expect(code).not.toMatch(/\b(legacy|port)\.\w+\(/);
  });

  it("renders its own fixtures: no local checkout path leaks into the template or fixtures", () => {
    for (const f of [
      join(TEMPLATES, "Handler.sol"),
      join(TOKEN_FIXTURE, "Targets.sol"),
      join(WALLET_FIXTURE, "Targets.sol"),
    ]) {
      expect(read(f)).not.toMatch(/\/Users\/|\/home\/|\/private\//);
    }
  });
});

describe.skipIf(skipReason !== "")(`Handler.sol template on forge (${skipReason || "native forge 1.5.1"})`, () => {
  it(
    "token fixture, full size: records, exorcism, no port bug, replay tail, taint, never reverts",
    () => {
      const p = assemble("token");
      try {
        const run = discovery(p, FULL);
        expect(run.status, run.output.slice(-3000)).toBe(0);
        expect(run.output).toMatch(/invariant_discovery\(\) \(runs: 256, calls: 16384, reverts: 0\)/);
        expect(run.output).toContain("Compiling 1 files with Solc 0.4.19");

        expectConsistent(run.lines);
        const { setup, seqs } = split(run.lines);

        // setup records first: constructor, token shares, seed calls, all idx -1
        expect(setup[0]!.function).toBe("constructor");
        expect(setup[0]!.classification).toBe("match");
        const shares = setup.filter((l, i) => i >= 1 && i <= 3);
        expect(shares.map((l) => l.function)).toEqual(["transfer", "transfer", "transfer"]);
        expect(shares.every((l) => l.sender.toLowerCase().endsWith("d0"))).toBe(true);
        // equal share = 1,000,000 / 4, to actors 1..3
        expect(shares.map((l) => word(l.calldata, 1))).toEqual([250_000n, 250_000n, 250_000n]);
        expect(shares.map((l) => word(l.calldata, 0))).toEqual([0xa1n, 0xa2n, 0xa3n]);
        // seed sequence: three transfers of 1 unit to Actor_Set indices 1..3 (decoded through _addr)
        const seeds = setup.slice(4);
        expect(seeds).toHaveLength(3);
        expect(seeds.map((l) => word(l.calldata, 0))).toEqual([0xa1n, 0xa2n, 0xa3n]);
        expect(seeds.every((l) => word(l.calldata, 1) === 1n)).toBe(true);

        // runs * depth fuzz lines at most, plus the replay tail: 256 sequences + the replayed last run
        expect(seqs).toHaveLength(INVARIANT_RUNS + 1);
        const kept = seqs.slice(0, INVARIANT_RUNS);
        const tail = seqs[INVARIANT_RUNS]!;
        expect(tail).toEqual(kept[INVARIANT_RUNS - 1]);
        expect(kept.every((s) => s.length <= INVARIANT_DEPTH)).toBe(true);
        expect(run.raw.length).toBeLessThanOrEqual(setup.length + INVARIANT_RUNS * INVARIANT_DEPTH + INVARIANT_DEPTH);

        // exorcism in batchTransfer, no port bug, and every sequence ends at its first exorcism
        const fuzz = kept.flat();
        const ex = fuzz.filter((l) => l.classification === "exorcised");
        expect(ex.length).toBeGreaterThan(0);
        expect(ex.every((l) => l.function === "batchTransfer")).toBe(true);
        expect(ex[0]!.legacy.success).toBe(true);
        expect(ex[0]!.port.data).toBe("0x4e487b710000000000000000000000000000000000000000000000000000000000000011");
        expect(run.lines.filter((l) => l.classification === "port-bug")).toHaveLength(0);
        for (const s of kept) {
          const i = s.findIndex((l) => l.classification === "exorcised");
          if (i >= 0) expect(i).toBe(s.length - 1);
        }
        // sequences are not all full length because the handler stops after an exorcism
        expect(kept.some((s) => s.length < INVARIANT_DEPTH)).toBe(true);
        // the generator-gap entry (length 2^200) is clamped to 24 receivers with value 1, never a revert
        const clamped = fuzz.filter(
          (l) => l.function === "batchTransfer" && word(l.calldata, 1) === 1n && word(l.calldata, 2) === 24n,
        );
        expect(clamped.length).toBeGreaterThan(0);
        // block context is derived from idx only: nothing to read back from records, so only check the run passed
      } finally {
        rmSync(p.dir, { recursive: true, force: true });
      }
    },
    FORGE_TIMEOUT,
  );

  it(
    "token fixture: handler unit tests (_pickTarget, _addr, _addressArray, _boundLen, _applyTargets clamp)",
    () => {
      const p = assemble("token");
      try {
        const r = runForge(p, ["--match-contract", "HandlerUnitTest"]);
        expect(r.status, r.output.slice(-3000)).toBe(0);
        expect(r.output).toMatch(/6 passed; 0 failed/);
      } finally {
        rmSync(p.dir, { recursive: true, force: true });
      }
    },
    FORGE_TIMEOUT,
  );

  it(
    "SEANCE_RECORD=0 switches recording off and the campaign still passes",
    () => {
      const p = assemble("token");
      try {
        const run = discovery(p, { ...SMALL, SEANCE_RECORD: "0" });
        expect(run.status, run.output.slice(-3000)).toBe(0);
        expect(run.raw).toHaveLength(0);
        expect(existsSync(join(p.dir, "seance-out/records.jsonl"))).toBe(false);
      } finally {
        rmSync(p.dir, { recursive: true, force: true });
      }
    },
    FORGE_TIMEOUT,
  );

  it(
    "planted port bug in batchTransfer (no balance decrement) is a port-bug with state differences, later records tainted",
    () => {
      const p = assemble("token");
      try {
        p.edit("src/port/PortToken.sol", (s) => {
          const from = s.indexOf("function batchTransfer(");
          const stmt = "balances[msg.sender] = balances[msg.sender] - amount;";
          const at = s.indexOf(stmt, from);
          if (at < 0) throw new Error("mutation site not found");
          return s.slice(0, at) + "// planted: no decrement" + s.slice(at + stmt.length);
        });
        const run = discovery(p, FULL);
        expect(run.status, run.output.slice(-3000)).toBe(0);
        expectConsistent(run.lines);
        const bugs = run.lines.filter((l) => l.classification === "port-bug");
        expect(bugs.length).toBeGreaterThan(0);
        const first = bugs.find((l) => !l.afterDivergence)!;
        expect(first.function).toBe("batchTransfer");
        expect(first.differingFields.some((f) => /^state\.balanceOf\(\d\)$/.test(f))).toBe(true);
        expect(first.legacy.stateFields).toBeDefined();
        expect(Object.keys(first.legacy.stateFields!)).toContain("balance");
        // within a sequence, after the first port-bug every record is tainted
        for (const s of split(run.lines).seqs) {
          const i = s.findIndex((l) => l.classification === "port-bug");
          if (i < 0) continue;
          expect(s[i]!.afterDivergence).toBe(false);
          expect(s.slice(i + 1).every((l) => l.afterDivergence)).toBe(true);
          expect(s.slice(0, i + 1).every((l) => !l.afterDivergence)).toBe(true);
        }
        // a port-bug does not stop the sequence
        expect(
          split(run.lines).seqs.some((s) => {
            const i = s.findIndex((l) => l.classification === "port-bug");
            return i >= 0 && s.length > i + 1;
          }),
        ).toBe(true);
      } finally {
        rmSync(p.dir, { recursive: true, force: true });
      }
    },
    FORGE_TIMEOUT,
  );

  it(
    "planted port bug in transfer shows in setup: the séance stops with setup records only",
    () => {
      const p = assemble("token");
      try {
        p.edit("src/port/PortToken.sol", (s) => {
          const from = s.indexOf("function transfer(");
          const stmt = "balances[msg.sender] = balances[msg.sender] - _value;";
          const at = s.indexOf(stmt, from);
          if (at < 0) throw new Error("mutation site not found");
          return s.slice(0, at) + "// planted: no decrement" + s.slice(at + stmt.length);
        });
        const run = discovery(p, SMALL);
        expect(run.status, run.output.slice(-3000)).toBe(0);
        expectConsistent(run.lines);
        expect(run.lines.every((l) => l.idx === -1)).toBe(true);
        const bugs = run.lines.filter((l) => l.classification === "port-bug");
        expect(bugs.length).toBeGreaterThan(0);
        expect(bugs[0]!.afterDivergence).toBe(false);
        expect(bugs[0]!.differingFields).toContain("state.balanceOf(0)");
        // every later setup record is tainted (the setup sequence keeps running to its end)
        const i = run.lines.indexOf(bugs[0]!);
        expect(run.lines.slice(i + 1).every((l) => l.afterDivergence)).toBe(true);
      } finally {
        rmSync(p.dir, { recursive: true, force: true });
      }
    },
    FORGE_TIMEOUT,
  );

  it(
    "wallet fixture: payable calls, fallbacks, logs normalised to SELF, assert inside the gas cap, address getters",
    () => {
      const p = assemble("wallet");
      try {
        const run = discovery(p, SMALL);
        expect(run.status, run.output.slice(-3000)).toBe(0);
        expect(run.output).toMatch(/reverts: 0\)/);
        expectConsistent(run.lines);
        // no false port bug: same sender balance on both sides (lastSenderBalance), logs equal under SELF
        expect(run.lines.filter((l) => l.classification === "port-bug")).toHaveLength(0);
        const fuzz = run.lines.filter((l) => l.idx >= 0);
        const byFn = (f: string) => fuzz.filter((l) => l.function === f);
        // both fallback handlers ran: empty calldata (selector "0x") and an unknown selector
        const fb = byFn("fallback");
        expect(fb.some((l) => l.calldata === "0x")).toBe(true);
        expect(fb.some((l) => l.calldata.length > 2 && l.selector.length === 10)).toBe(true);
        expect(fb.every((l) => l.legacy.success && l.port.success)).toBe(true);
        // payable calls with value
        const dep = byFn("deposit").filter((l) => l.legacy.success);
        expect(dep.length).toBeGreaterThan(0);
        expect(dep.some((l) => BigInt(l.value) > 0n)).toBe(true);
        expect(dep.every((l) => l.legacy.logs.length === 1 && l.legacy.logs[0]!.emitter === "SELF")).toBe(true);
        expect(dep.every((l) => JSON.stringify(l.legacy.logs) === JSON.stringify(l.port.logs))).toBe(true);
        // legacy assert burns the forwarded gas but control returns: both fail, reasons differ
        const crash = byFn("crash");
        expect(crash.length).toBeGreaterThan(0);
        expect(crash.every((l) => !l.legacy.success && !l.port.success)).toBe(true);
        expect(crash.every((l) => l.classification === "reason-modernised")).toBe(true);
        // setup: constructor, then the seed call approve(actor 1 -> index 4 = address(0), 7)
        const setup = run.lines.filter((l) => l.idx === -1);
        expect(setup.map((l) => l.function)).toEqual(["constructor", "approve"]);
        expect(word(setup[1]!.calldata, 0)).toBe(0n);
        expect(word(setup[1]!.calldata, 1)).toBe(7n);
        expect(setup[1]!.sender.toLowerCase().endsWith("a1")).toBe(true);
      } finally {
        rmSync(p.dir, { recursive: true, force: true });
      }
    },
    FORGE_TIMEOUT,
  );

  it(
    "wallet fixture: a dropped emit in the port is a setup port-bug on `logs` and stops the séance",
    () => {
      const p = assemble("wallet");
      try {
        p.edit("src/port/PortWallet.sol", (s) => s.replace("emit Approval(msg.sender, s, v);", ""));
        const run = discovery(p, SMALL);
        expect(run.status, run.output.slice(-3000)).toBe(0);
        expectConsistent(run.lines);
        expect(run.lines.every((l) => l.idx === -1)).toBe(true);
        const bug = run.lines.find((l) => l.classification === "port-bug")!;
        expect(bug.function).toBe("approve");
        expect(bug.differingFields).toEqual(["logs"]);
        expect(bug.legacy.logs).toHaveLength(1);
        expect(bug.port.logs).toHaveLength(0);
      } finally {
        rmSync(p.dir, { recursive: true, force: true });
      }
    },
    FORGE_TIMEOUT,
  );

  it(
    "wallet fixture: a wrong stored allowance is found through the two-address getter",
    () => {
      const p = assemble("wallet");
      try {
        // the seed call approves address(0), which no pair getter covers; the fuzzed calls cover actors
        p.edit("src/port/PortWallet.sol", (s) => s.replace("allowed[msg.sender][s] = v;", "allowed[msg.sender][s] = v + 1;"));
        const run = discovery(p, SMALL);
        expect(run.status, run.output.slice(-3000)).toBe(0);
        expectConsistent(run.lines);
        const bug = run.lines.find((l) => l.classification === "port-bug");
        expect(bug).toBeDefined();
        expect(bug!.differingFields.some((f) => /^state\.allowed\(\d,\d\)$/.test(f))).toBe(true);
      } finally {
        rmSync(p.dir, { recursive: true, force: true });
      }
    },
    FORGE_TIMEOUT,
  );

  it(
    "wallet fixture: constructor outcomes end the séance (both revert identically; both revert differently)",
    () => {
      for (const [portCtor, expected] of [
        ["require(x != 0);", "match"],
        ['require(x != 0, "zero");', "reason-modernised"],
      ] as const) {
        const p = assemble("wallet");
        try {
          p.edit("test/handler/Targets.sol", (s) => s.replace("abi.encode(uint256(1))", "abi.encode(uint256(0))"));
          p.edit("src/port/PortWallet.sol", (s) => s.replace("require(x != 0);", portCtor));
          const run = discovery(p, SMALL);
          expect(run.status, run.output.slice(-3000)).toBe(0);
          expect(run.lines).toHaveLength(1);
          expect(run.lines[0]!.function).toBe("constructor");
          expect(run.lines[0]!.idx).toBe(-1);
          expect(run.lines[0]!.classification).toBe(expected);
          expect(run.lines[0]!.legacy.success).toBe(false);
          expect(run.lines[0]!.port.success).toBe(false);
          expectConsistent(run.lines);
        } finally {
          rmSync(p.dir, { recursive: true, force: true });
        }
      }
    },
    FORGE_TIMEOUT,
  );

  it(
    "wallet fixture: constructors that differ in outcome are a port-bug and end the séance",
    () => {
      const p = assemble("wallet");
      try {
        p.edit("src/port/PortWallet.sol", (s) => s.replace("require(x != 0);", ""));
        p.edit("test/handler/Targets.sol", (s) => s.replace("abi.encode(uint256(1))", "abi.encode(uint256(0))"));
        const run = discovery(p, SMALL);
        expect(run.status, run.output.slice(-3000)).toBe(0);
        expect(run.lines).toHaveLength(1);
        expect(run.lines[0]!.classification).toBe("port-bug");
        expect(run.lines[0]!.differingFields).toEqual(["success"]);
        expect(run.lines[0]!.legacy.success).toBe(false);
        expect(run.lines[0]!.port.success).toBe(true);
      } finally {
        rmSync(p.dir, { recursive: true, force: true });
      }
    },
    FORGE_TIMEOUT,
  );
});
