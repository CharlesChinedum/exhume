/**
 * Task 8.5 calibration experiment for `MAX_HANDLER_STACK` / `estimateHandlerStack`. Skipped unless
 * `STACK_EXPERIMENT=1` (it runs hundreds of forge builds). Compiles the REAL generated handler (skip disabled
 * with `maxHandlerStack: Infinity`) for synthetic functions and writes a JSON table of pass/fail to
 * `$STACK_EXPERIMENT_OUT` (default /tmp/stack-experiment.json).
 *
 *   STACK_EXPERIMENT=1 STACK_MODE=homogeneous|random|check [STACK_OPT=1] pnpm --filter @exhume/engine exec vitest run stack-experiment
 *
 * Mode `check` compiles every signature accepted by the estimator, and a few rejected ones, and reports
 * soundness (an accepted signature that fails) and conservativeness (a rejected signature that compiles).
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_HANDLER_STACK, estimateHandlerStack, generateSrcProject, generateTestProject } from "../../src/seance/project-generator.js";
import type { AbiFunction, SeanceInput } from "../../src/seance/types.js";
import { LOCAL_STD, skipReason } from "./template-project.js";

const ON = process.env["STACK_EXPERIMENT"] === "1" && skipReason === "";
const MODE = process.env["STACK_MODE"] ?? "homogeneous";
const OPT = process.env["STACK_OPT"] === "1";
const OUT = process.env["STACK_EXPERIMENT_OUT"] ?? "/tmp/stack-experiment.json";

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

export function fnOf(code: string, payable: boolean): AbiFunction {
  return {
    type: "function",
    name: "f",
    inputs: [...code].map((c, i) => ({ name: `x${i}`, type: KINDS[c] as string })),
    outputs: [],
    stateMutability: payable ? "payable" : "nonpayable",
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

function setup(): string {
  const dir = mkdtempSync(join(tmpdir(), "exhume-stack-"));
  const src = generateSrcProject(INPUT, { forgeStdDir: LOCAL_STD });
  if (!src.ok) throw new Error(src.error.message);
  for (const f of src.value) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.contents);
  }
  if (OPT) {
    // Not a real configuration: lets the default profile (which compiles test/**) use the optimizer.
    const t = join(dir, "foundry.toml");
    writeFileSync(t, readTomlWithOptimizer(dir));
  }
  return dir;
}
function readTomlWithOptimizer(dir: string): string {
  return readFileSync(join(dir, "foundry.toml"), "utf8").replace("optimizer = false", "optimizer = true");
}

/** true = compiles, false = Stack too deep, string = another error. */
async function compiles(dir: string, fn: AbiFunction): Promise<boolean | string> {
  const t = generateTestProject(INPUT, { sites: [], seedSequences: [] }, [fn], { forgeStdDir: LOCAL_STD, maxHandlerStack: Infinity });
  if (!t.ok) return t.error.message;
  for (const f of t.value.files) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.contents);
  }
  const { status, out } = await new Promise<{ status: number | null; out: string }>((res) => {
    const c = spawn("forge", ["build", "--offline"], { cwd: dir });
    let buf = "";
    c.stdout.on("data", (d) => (buf += d));
    c.stderr.on("data", (d) => (buf += d));
    c.on("close", (code) => res({ status: code, out: buf }));
  });
  if (status === 0) return true;
  return /Stack too deep/i.test(out) ? false : out.slice(0, 400);
}

interface Row {
  code: string;
  payable: boolean;
  estimate: number;
  result: boolean | string;
}

async function runAll(cases: { code: string; payable: boolean }[]): Promise<Row[]> {
  const rows: Row[] = [];
  const queue = [...cases];
  const workers = Array.from({ length: 6 }, async () => {
    const dir = setup();
    try {
      for (;;) {
        const c = queue.shift();
        if (!c) return;
        const fn = fnOf(c.code, c.payable);
        rows.push({ ...c, estimate: estimateHandlerStack(fn), result: await compiles(dir, fn) });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  await Promise.all(workers);
  return rows.sort((a, b) => (a.code + a.payable < b.code + b.payable ? -1 : 1));
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe.skipIf(!ON)("stack experiment", () => {
  it(
    `runs ${MODE}`,
    async () => {
      let cases: { code: string; payable: boolean }[] = [];
      if (MODE === "homogeneous") {
        for (const k of Object.keys(KINDS)) for (const payable of [false, true]) for (let n = 1; n <= 16; n++) cases.push({ code: k.repeat(n), payable });
      } else if (MODE === "random") {
        const r = rng(7);
        const kinds = Object.keys(KINDS);
        const seen = new Set<string>();
        while (cases.length < Number(process.env["STACK_N"] ?? 300)) {
          const n = 3 + Math.floor(r() * 9);
          let code = "";
          for (let i = 0; i < n; i++) code += kinds[Math.floor(r() * kinds.length)];
          const payable = r() < 0.3;
          if (seen.has(code + payable)) continue;
          seen.add(code + payable);
          cases.push({ code, payable });
        }
      } else {
        // check: random signatures, biased towards the estimator's boundary
        const r = rng(Number(process.env["STACK_SEED"] ?? 99));
        const kinds = Object.keys(KINDS);
        const seen = new Set<string>();
        while (cases.length < Number(process.env["STACK_N"] ?? 300)) {
          const n = 1 + Math.floor(r() * 14);
          let code = "";
          for (let i = 0; i < n; i++) code += kinds[Math.floor(r() * kinds.length)];
          const payable = r() < 0.3;
          const e = estimateHandlerStack(fnOf(code, payable));
          if (Math.abs(e - MAX_HANDLER_STACK) > 4 || seen.has(code + payable)) continue;
          seen.add(code + payable);
          cases.push({ code, payable });
        }
      }
      const rows = await runAll(cases);
      writeFileSync(OUT, JSON.stringify(rows, null, 1));
      const other = rows.filter((x) => typeof x.result === "string");
      expect(other, JSON.stringify(other.slice(0, 2))).toEqual([]);
    },
    3_600_000,
  );
});
