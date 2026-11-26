/**
 * Task 8.4: the real Seance.t.sol, Witness.t.sol and Replay.t.sol templates, run natively with forge on
 * the token fixture (hand-written parts stand in for the Project_Generator, task 8.5).
 * The replay call decoding in these tests (`callStatement`) is hand-written test code, not the generator's.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INVARIANT_DEPTH, INVARIANT_RUNS, SHRINK_RUN_LIMIT_ENV, WITNESS_SHRINK_RUN_LIMIT } from "../../src/seance/forge-std-pin.js";
import { verifyTaint } from "../../src/seance/taint.js";
import {
  FORGE_TIMEOUT,
  TEMPLATES,
  assemble,
  callStatement,
  parseCx,
  read,
  readRecords,
  runForge,
  skipReason,
  witnessResult,
  type Project,
} from "./template-project.js";

const WITNESS_ENV = { SEANCE_RECORD: "0", [SHRINK_RUN_LIMIT_ENV]: String(WITNESS_SHRINK_RUN_LIMIT) };
const SEED = ["--fuzz-seed", "42"];

const witness = (p: Project, k: number, seed: string[] = SEED) =>
  runForge(p, ["--json", ...seed, "--match-contract", `^Witness${k}$`, "--match-test", "invariant_witness"], WITNESS_ENV);

describe("templates (static)", () => {
  const seance = read(join(TEMPLATES, "Seance.t.sol"));
  const wit = read(join(TEMPLATES, "Witness.t.sol"));
  const rep = read(join(TEMPLATES, "Replay.t.sol"));
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("Seance.t.sol: SeanceDiscovery with exactly one invariant_ function and one marker line", () => {
    expect(seance).toMatch(/^pragma solidity 0\.8\.28;$/m);
    expect(code(seance).match(/contract SeanceDiscovery /g)).toHaveLength(1);
    expect(code(seance).match(/function invariant_\w*/g)).toEqual(["function invariant_discovery"]);
    expect(code(seance)).toMatch(/targetContract\(address\(handler\)\)/);
    expect(code(seance)).toMatch(/function invariant_discovery\(\) public view \{\}/);
    expect(seance.match(/^[ \t]*\/\/ @@HANDLER_SELECTORS@@$/gm)).toHaveLength(1);
  });

  it("Witness.t.sol: Witness1..10, one invariant_witness, own index each, two markers", () => {
    const names = [...code(wit).matchAll(/contract (Witness\d+) is WitnessBase \{\s*function setUp\(\) public \{ _setUp\((\d+)\); \}/g)];
    expect(names.map((m) => m[1])).toEqual(Array.from({ length: 10 }, (_, i) => `Witness${i + 1}`));
    expect(names.map((m) => m[2])).toEqual(Array.from({ length: 10 }, (_, i) => String(i + 1)));
    expect(code(wit).match(/function invariant_\w*/g)).toEqual(["function invariant_witness"]);
    expect(wit.match(/^[ \t]*\/\/ @@HANDLER_SELECTORS@@$/gm)).toHaveLength(1);
    expect(wit.match(/^[ \t]*\/\/ @@WITNESS_PAIRS@@$/gm)).toHaveLength(1);
  });

  it("Replay.t.sol: SeanceReplay1..10, own output path before init, one test_replay and one marker each", () => {
    for (let k = 1; k <= 10; k++) {
      expect(rep).toMatch(new RegExp(`contract SeanceReplay${k} is ReplayBase \\{\\s*function setUp\\(\\) public \\{ _setUp\\("seance-out/replay-${k}\\.jsonl"\\); \\}`));
      expect(rep.match(new RegExp(`^[ \\t]*// @@REPLAY_CALLS_${k}@@$`, "gm"))).toHaveLength(1);
    }
    expect(code(rep).match(/function test_replay\(\) public/g)).toHaveLength(10);
    const base = code(rep).slice(code(rep).indexOf("abstract contract ReplayBase"), code(rep).indexOf("contract SeanceReplay1 "));
    expect(base.indexOf("setOutputPath(path)")).toBeGreaterThan(-1);
    expect(base.indexOf("setOutputPath(path)")).toBeLessThan(base.indexOf("handler.init()"));
  });
});

describe.skipIf(skipReason !== "")(`templates on forge (${skipReason || "native forge 1.5.1"})`, () => {
  it(
    "(a) discovery, full 256x64: passes, one invariant function, recording on, setup records first",
    () => {
      const p = assemble("token");
      try {
        const r = runForge(
          p,
          ["--json", ...SEED, "--match-contract", "^SeanceDiscovery$", "--match-test", "invariant_discovery"],
          { SEANCE_RECORD: "1", FOUNDRY_INVARIANT_RUNS: String(INVARIANT_RUNS), FOUNDRY_INVARIANT_DEPTH: String(INVARIANT_DEPTH) },
        );
        expect(r.status, r.output.slice(-2000)).toBe(0);
        const doc = r.json as Record<string, { test_results: Record<string, { status: string }> }>;
        const results = Object.values(doc).flatMap((e) => Object.entries(e.test_results));
        expect(results.map(([n]) => n)).toEqual(["invariant_discovery()"]);
        expect(results[0]![1].status).toBe("Success");
        const lines = readRecords(p, "seance-out/records.jsonl");
        // 256 sequences plus the replayed last run (decision 13)
        expect(lines.filter((l) => l.idx === 0)).toHaveLength(INVARIANT_RUNS + 1);
        expect(lines.slice(0, 7).every((l) => l.idx === -1)).toBe(true);
        expect(lines[7]!.idx).toBe(0);
        expect(lines.filter((l) => l.classification === "exorcised").length).toBeGreaterThan(0);
        expect(lines.filter((l) => l.classification === "port-bug")).toHaveLength(0);
      } finally {
        rmSync(p.dir, { recursive: true, force: true });
      }
    },
    FORGE_TIMEOUT,
  );

  it(
    "(d) anchored --match-contract: Witness1 does not select Witness10, SeanceReplay1 not SeanceReplay10",
    () => {
      const p = assemble("token");
      try {
        for (const [pat, other] of [
          ["^Witness1$", "Witness10"],
          ["^SeanceReplay1$", "SeanceReplay10"],
        ] as const) {
          const r = runForge(p, ["--list", "--json", "--match-contract", pat]);
          expect(r.status, r.output.slice(-1500)).toBe(0);
          const text = JSON.stringify(r.json ?? r.output);
          expect(text).toContain(pat.slice(1, -1));
          expect(text).not.toContain(other);
        }
        // control: the unanchored pattern does match both
        const loose = runForge(p, ["--list", "--json", "--match-contract", "Witness1"]);
        expect(JSON.stringify(loose.json ?? loose.output)).toContain("Witness10");
      } finally {
        rmSync(p.dir, { recursive: true, force: true });
      }
    },
    FORGE_TIMEOUT,
  );

  it(
    "(b)+(c) witness shrinks a real exorcism; a never-hit pair passes; the shrunk sequence replays in parallel replay contracts",
    () => {
      const p = assemble("token");
      let cx;
      try {
        // (b) Witness1 = (batchTransfer, exorcised): fails with counterexample.Sequence[1]
        const hit = witness(p, 1);
        expect(hit.status, hit.output.slice(-2000)).not.toBe(0);
        expect(witnessResult(hit.json)!.status).toBe("Failure");
        cx = parseCx(hit.json);
        expect(cx, "counterexample.Sequence missing").toBeDefined();
        console.info(`witness (batchTransfer, exorcised): originalLength=${cx!.originalLength} shrunkLength=${cx!.calls.length}`);
        expect(cx!.calls.length).toBeGreaterThanOrEqual(1);
        expect(cx!.calls.length).toBeLessThanOrEqual(cx!.originalLength);
        expect(cx!.calls[cx!.calls.length - 1]!.func_name).toBe("handler_batchTransfer");
        for (const c of cx!.calls) {
          expect(c.calldata).toMatch(/^0x[0-9a-f]+$/);
          expect(c.sender).toMatch(/^0x[0-9a-fA-F]{40}$/);
        }
        // SEANCE_RECORD=0: no record file
        expect(readRecords(p, "seance-out/records.jsonl")).toHaveLength(0);

        // Witness2 = (transfer, port-bug): never happens on the unmodified port, passes
        const miss = witness(p, 2);
        expect(miss.status, miss.output.slice(-2000)).toBe(0);
        expect(witnessResult(miss.json)!.status).toBe("Success");
        expect(witnessResult(miss.json)!.counterexample).toBeNull();
      } finally {
        rmSync(p.dir, { recursive: true, force: true });
      }

      // (c) replay: contract 1 from the shrunk counterexample, contract 2 from the hand-written fixture call
      const calls = cx!.calls.map(callStatement).join("\n");
      const q = assemble("token", { replayCalls: { 1: calls } });
      // second replay contract with the hand-written fixture call (`fixture replay-calls-1`)
      q.edit("test/Replay.t.sol", (s) =>
        s.replace(
          /^[ \t]*\/\/ @@REPLAY_CALLS_2@@$/m,
          "        handler.handler_batchTransfer(3, 1, 2, 0, 57896044618658097711785492504343953926634992332820282019728792003956564819968);",
        ),
      );
      try {
        const r = runForge(q, ["--json", ...SEED, "--match-contract", "^SeanceReplay(1|2)$"], { SEANCE_RECORD: "1" });
        expect(r.status, r.output.slice(-2000)).toBe(0);
        const doc = r.json as Record<string, { test_results: Record<string, { status: string }> }>;
        const keys = Object.keys(doc).sort();
        expect(keys.map((k) => k.split(":")[1])).toEqual(["SeanceReplay1", "SeanceReplay2"]);
        for (const e of Object.values(doc)) expect(e.test_results["test_replay()"]!.status).toBe("Success");

        for (const [k, n] of [
          [1, cx!.calls.length],
          [2, 1],
        ] as const) {
          const lines = readRecords(q, `seance-out/replay-${k}.jsonl`);
          const setup = lines.filter((l) => l.idx === -1);
          const fuzz = lines.filter((l) => l.idx >= 0);
          expect(setup.map((l) => l.function)).toEqual([
            "constructor", "transfer", "transfer", "transfer", "transfer", "transfer", "transfer",
          ]);
          expect(fuzz).toHaveLength(n);
          expect(fuzz.map((l) => l.idx)).toEqual(fuzz.map((_, i) => i));
          const last = lines[lines.length - 1]!;
          expect(last.function).toBe("batchTransfer");
          expect(last.classification).toBe("exorcised");
          expect(last.afterDivergence).toBe(false);
          expect(verifyTaint(lines).ok).toBe(true);
        }
        // the two files are separate files with their own content
        const l1 = readRecords(q, "seance-out/replay-1.jsonl");
        const l2 = readRecords(q, "seance-out/replay-2.jsonl");
        expect(l1.length).toBe(7 + cx!.calls.length);
        expect(l2.length).toBe(8);
        // replay-3 was never created (no SeanceReplay3 ran)
        expect(readRecords(q, "seance-out/replay-3.jsonl")).toHaveLength(0);
      } finally {
        rmSync(q.dir, { recursive: true, force: true });
      }
    },
    FORGE_TIMEOUT,
  );

  it(
    "(b) taint: on a planted-bug port a witness fires for the untainted first class and not for a class that only occurs tainted",
    () => {
      // Plant: port batchTransfer does not decrement the sender balance (a port-bug on batchTransfer).
      // A later `transfer` then differs in observable state (balanceOf), a port-bug, but always tainted.
      const pairs =
        '        if (k == 1) return ("batchTransfer", Classifier.Class.PortBug);\n' +
        '        if (k == 2) return ("transfer", Classifier.Class.PortBug);\n';
      const p = assemble("token", { witnessPairs: pairs });
      try {
        p.edit("src/port/PortToken.sol", (s) => {
          const from = s.indexOf("function batchTransfer(");
          const stmt = "balances[msg.sender] = balances[msg.sender] - amount;";
          const at = s.indexOf(stmt, from);
          if (at < 0) throw new Error("mutation site not found");
          return s.slice(0, at) + "// planted: no decrement" + s.slice(at + stmt.length);
        });

        // discovery: a tainted transfer port-bug exists, and no untainted one
        const d = runForge(
          p,
          ["--json", ...SEED, "--match-contract", "^SeanceDiscovery$", "--match-test", "invariant_discovery"],
          { SEANCE_RECORD: "1" },
        );
        expect(d.status, d.output.slice(-2000)).toBe(0);
        const lines = readRecords(p, "seance-out/records.jsonl");
        const tp = lines.filter((l) => l.function === "transfer" && l.classification === "port-bug");
        expect(tp.length).toBeGreaterThan(0);
        expect(tp.every((l) => l.afterDivergence)).toBe(true);
        expect(lines.some((l) => l.function === "batchTransfer" && l.classification === "port-bug" && !l.afterDivergence)).toBe(true);

        const w1 = witness(p, 1);
        expect(w1.status, w1.output.slice(-2000)).not.toBe(0);
        expect(parseCx(w1.json)).toBeDefined();
        const w2 = witness(p, 2);
        expect(w2.status, w2.output.slice(-2000)).toBe(0);
        expect(witnessResult(w2.json)!.counterexample).toBeNull();
      } finally {
        rmSync(p.dir, { recursive: true, force: true });
      }
    },
    FORGE_TIMEOUT,
  );
});
