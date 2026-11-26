/**
 * Task 8.8 (B): the legacy `assert` (invalid opcode) returns control to the handler within GAS_CAP,
 * the handler records the call, and the séance continues. Uses the handler-wallet fixture, whose
 * `crash()` is `assert(false)` in the legacy contract (the port's assert reverts with Panic(0x01)).
 * Also covers the opposite case: the port asserts and the legacy does not (a port-bug record, not a handler revert).
 */
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORGE_TIMEOUT,
  WALLET_FIXTURE,
  assemble,
  readRecords,
  runForge,
  skipReason,
  type Project,
} from "./template-project.js";

const PANIC_1 = "0x4e487b710000000000000000000000000000000000000000000000000000000000000001";
const SMALL = { FOUNDRY_INVARIANT_RUNS: "32", FOUNDRY_INVARIANT_DEPTH: "24" };

function withGasTest(): Project {
  const p = assemble("wallet");
  cpSync(join(WALLET_FIXTURE, "GasCap.t.sol"), join(p.dir, "test/GasCap.t.sol"));
  return p;
}
const gasOf = (out: string, label: string): number => {
  const m = out.match(new RegExp(`${label}:\\s+(\\d+)`));
  if (!m) throw new Error(`${label} not in forge output`);
  return Number(m[1]);
};

describe.skipIf(skipReason !== "")(`legacy assert and GAS_CAP (${skipReason || "native forge"})`, () => {
  it(
    "legacy assert: the handler call returns at about GAS_CAP, is recorded as reason-modernised, and the séance continues",
    () => {
      const p = withGasTest();
      try {
        const unit = runForge(p, ["--match-contract", "GasCapTest", "-vv"]);
        expect(unit.status, unit.output.slice(-3000)).toBe(0);
        const used = gasOf(unit.output, "CRASH_GAS_USED");
        // legacy burns the full 10,000,000 it was given; the port's Panic and the state reads are cheap
        expect(used).toBeGreaterThanOrEqual(10_000_000);
        expect(used).toBeLessThan(10_500_000);
        const recs = readRecords(p, "seance-out/records.jsonl");
        expect(recs.map((r) => r.function)).toEqual(["constructor", "approve", "crash", "approve", "deposit"]);
        const crash = recs[2]!;
        expect(crash.legacy.success).toBe(false);
        expect(crash.legacy.data).toBe("0x"); // invalid opcode: no return data
        expect(crash.port.success).toBe(false);
        expect(crash.port.data).toBe(PANIC_1);
        expect(crash.classification).toBe("reason-modernised");
        expect(crash.differingFields).toEqual([]);
        expect(recs[3]!.legacy.success && recs[3]!.port.success).toBe(true);
        console.log(`observed: handler_crash gas = ${used} (GAS_CAP = 10000000), next call gas = ${gasOf(unit.output, "NEXT_CALL_GAS_USED")}`);

        // Campaign: fail_on_revert = true, so any handler revert fails the run.
        const t0 = Date.now();
        const run = runForge(p, ["--match-contract", "SeanceDiscovery", "--fuzz-seed", "42"], SMALL);
        const secs = (Date.now() - t0) / 1000;
        expect(run.status, run.output.slice(-3000)).toBe(0);
        expect(run.output).toMatch(/invariant_discovery\(\) \(runs: 32, calls: \d+, reverts: 0\)/);
        const all = readRecords(p, "seance-out/records.jsonl");
        const crashes = all.filter((r) => r.function === "crash" && r.idx >= 0);
        expect(crashes.length).toBeGreaterThan(0);
        expect(crashes.every((r) => r.classification === "reason-modernised")).toBe(true);
        // a crash in the middle of a sequence is followed by records of the same sequence
        let followed = 0;
        all.forEach((r, i) => {
          const next = all[i + 1];
          if (r.function === "crash" && r.idx >= 0 && next && next.idx === r.idx + 1) followed++;
        });
        expect(followed).toBeGreaterThan(0);
        console.log(`observed: campaign 32x24 with ${crashes.length} crash records, ${followed} followed by a later call, ${secs.toFixed(1)} s`);
      } finally {
        rmSync(p.dir, { recursive: true, force: true });
      }
    },
    FORGE_TIMEOUT,
  );

  it(
    "port assert, legacy succeeds: a port-bug record, the handler does not revert, the séance continues",
    () => {
      const p = withGasTest();
      try {
        p.edit("src/legacy/LegacyWallet.sol", (s) => {
          expect(s).toContain("assert(false);");
          return s.replace("assert(false);", "hits += 1;");
        });
        const unit = runForge(p, ["--match-contract", "GasCapTest", "-vv"]);
        expect(unit.status, unit.output.slice(-3000)).toBe(0);
        const used = gasOf(unit.output, "CRASH_GAS_USED");
        expect(used).toBeLessThan(1_000_000); // no invalid opcode on either side: nothing burns the cap
        const recs = readRecords(p, "seance-out/records.jsonl");
        const crash = recs[2]!;
        expect(crash.function).toBe("crash");
        expect(crash.legacy.success).toBe(true);
        expect(crash.port.success).toBe(false);
        expect(crash.port.data).toBe(PANIC_1);
        expect(crash.classification).toBe("port-bug");
        expect(crash.differingFields).toEqual(["returnData", "success"]);
        expect(crash.afterDivergence).toBe(false);
        // calls after the port-bug are recorded and tainted; the séance is not stopped
        expect(recs.slice(3).length).toBe(2);
        expect(recs.slice(3).every((r) => r.afterDivergence)).toBe(true);
        console.log(`observed: port-assert handler_crash gas = ${used}`);

        const run = runForge(p, ["--match-contract", "SeanceDiscovery", "--fuzz-seed", "42"], SMALL);
        expect(run.status, run.output.slice(-3000)).toBe(0);
        expect(run.output).toMatch(/invariant_discovery\(\) \(runs: 32, calls: \d+, reverts: 0\)/);
        const all = readRecords(p, "seance-out/records.jsonl");
        const bugs = all.filter((r) => r.classification === "port-bug" && r.idx >= 0);
        expect(bugs.length).toBeGreaterThan(0);
        expect(bugs.every((r) => r.function === "crash" || r.afterDivergence)).toBe(true);
        expect(all.some((r, i) => r.classification === "port-bug" && all[i + 1]?.idx === r.idx + 1)).toBe(true);
      } finally {
        rmSync(p.dir, { recursive: true, force: true });
      }
    },
    FORGE_TIMEOUT,
  );
});
