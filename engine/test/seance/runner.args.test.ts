import { describe, expect, it } from "vitest";
import {
  buildForgeArgs,
  isExpired,
  makeDeadline,
  phaseBudgetMs,
  remainingMs,
  type Phase,
} from "../../src/seance/runner.js";

function inv(phase: Phase, fuzzSeed?: string) {
  const r = buildForgeArgs(phase, fuzzSeed === undefined ? {} : { fuzzSeed });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("deadline", () => {
  it("budget is the time remaining before the single deadline", () => {
    const d = makeDeadline(1_000, 300);
    expect(d.at).toBe(301_000);
    expect(phaseBudgetMs(d, 1_000)).toBe(300_000);
    expect(remainingMs(d, 2_500)).toBe(298_500);
  });

  it("build time reduces the discovery budget", () => {
    const d = makeDeadline(0, 300);
    const afterBuild = phaseBudgetMs(d, 120_000);
    expect(afterBuild).toBe(180_000);
    expect(afterBuild).toBeLessThan(phaseBudgetMs(d, 0));
  });

  it("is never negative and expires exactly at the deadline", () => {
    const d = makeDeadline(0, 10);
    expect(isExpired(d, 9_999)).toBe(false);
    expect(phaseBudgetMs(d, 10_000)).toBe(0);
    expect(isExpired(d, 10_000)).toBe(true);
    expect(phaseBudgetMs(d, 99_999)).toBe(0);
  });
});

describe("buildForgeArgs", () => {
  it("build", () => {
    expect(inv({ kind: "build" }, "1")).toEqual({ args: ["build", "--offline"], env: {} });
  });

  it("discovery", () => {
    expect(inv({ kind: "discovery" }, "42")).toEqual({
      args: [
        "test", "--offline", "--json",
        "--match-contract", "^SeanceDiscovery$",
        "--match-test", "invariant_discovery",
        "--fuzz-seed", "42",
      ],
      env: { SEANCE_RECORD: "1" },
    });
  });

  it("witness k", () => {
    expect(inv({ kind: "witness", k: 3 }, "42")).toEqual({
      args: [
        "test", "--offline", "--json",
        "--match-contract", "^Witness3$",
        "--match-test", "invariant_witness",
        "--fuzz-seed", "42",
      ],
      env: { SEANCE_RECORD: "0", FOUNDRY_INVARIANT_SHRINK_RUN_LIMIT: "5000" },
    });
  });

  it("replay k", () => {
    expect(inv({ kind: "replay", k: 10 }, "42")).toEqual({
      args: ["test", "--offline", "--json", "--match-contract", "^SeanceReplay10$", "--fuzz-seed", "42"],
      env: { SEANCE_RECORD: "1" },
    });
  });

  it("anchors keep k=1 from matching k=10", () => {
    const w = new RegExp(inv({ kind: "witness", k: 1 }).args[4]!);
    const r = new RegExp(inv({ kind: "replay", k: 1 }).args[4]!);
    expect(w.test("Witness1")).toBe(true);
    expect(w.test("Witness10")).toBe(false);
    expect(r.test("SeanceReplay1")).toBe(true);
    expect(r.test("SeanceReplay10")).toBe(false);
  });

  it("passes the seed through unchanged", () => {
    const seeds = ["42", "0x2a", "9".repeat(78), "007", " 5 "];
    for (const s of seeds) {
      for (const p of [{ kind: "discovery" }, { kind: "witness", k: 1 }, { kind: "replay", k: 2 }] as Phase[]) {
        const { args } = inv(p, s);
        expect(args.at(-2)).toBe("--fuzz-seed");
        expect(args.at(-1)).toBe(s);
      }
    }
  });

  it("omits --fuzz-seed without a seed", () => {
    for (const p of [{ kind: "discovery" }, { kind: "witness", k: 1 }, { kind: "replay", k: 1 }] as Phase[]) {
      expect(inv(p).args).not.toContain("--fuzz-seed");
    }
  });

  it("sets shrink limit and SEANCE_RECORD=0 only for witness", () => {
    expect(inv({ kind: "witness", k: 1 }).env).toHaveProperty("SEANCE_RECORD", "0");
    for (const p of [{ kind: "build" }, { kind: "discovery" }, { kind: "replay", k: 1 }] as Phase[]) {
      const env = inv(p).env;
      expect(env.SEANCE_RECORD).not.toBe("0");
      expect(env).not.toHaveProperty("FOUNDRY_INVARIANT_SHRINK_RUN_LIMIT");
    }
  });

  it("rejects invalid k with INVALID_INPUT", () => {
    for (const k of [0, 11, -1, 1.5, NaN, Infinity]) {
      for (const kind of ["witness", "replay"] as const) {
        const r = buildForgeArgs({ kind, k });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
      }
    }
  });

  it("is deterministic", () => {
    expect(buildForgeArgs({ kind: "witness", k: 4 }, { fuzzSeed: "7" })).toEqual(
      buildForgeArgs({ kind: "witness", k: 4 }, { fuzzSeed: "7" }),
    );
  });
});
