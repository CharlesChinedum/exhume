/**
 * Test helper (task 8.4): assembles a Foundry project from the real templates in
 * src/seance/templates plus the hand-written fixture parts, the way the Project_Generator (8.5)
 * will. Not a test file.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderFoundryToml } from "../../src/seance/foundry-config.js";
import { remappingsText } from "../../src/seance/forge-std-pin.js";
import type { RecordLine } from "../../src/seance/types.js";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ENGINE = resolve(HERE, "../..");
export const TEMPLATES = join(ENGINE, "src/seance/templates");
export const TOKEN_FIXTURE = join(HERE, "fixtures/handler");
export const WALLET_FIXTURE = join(HERE, "fixtures/handler-wallet");
export const DOCKER_TOKEN = join(ENGINE, "test/docker/fixtures/token");
export const LOCAL_STD = join(ENGINE, "test/docker/.cache/forge-std");

export const forgeOk = spawnSync("forge", ["--version"], { encoding: "utf8" }).status === 0;
export const stdOk = existsSync(join(LOCAL_STD, "src/Test.sol"));
export const skipReason = !forgeOk
  ? "forge is not on PATH"
  : !stdOk
    ? `local forge-std checkout missing at ${LOCAL_STD}`
    : "";
export const FORGE_TIMEOUT = 300_000;

export const read = (p: string): string => readFileSync(p, "utf8");

/** Replaces the whole marker line `<indent>// @@NAME@@` (any indentation) with `body`. */
export function fillMarker(template: string, marker: string, body: string): string {
  const re = new RegExp(`^[ \\t]*// @@${marker}@@[ \\t]*$`, "m");
  if (!re.test(template)) throw new Error(`marker ${marker} not found`);
  return template.replace(re, () => body.replace(/\n$/, ""));
}

export type Kind = "token" | "wallet";

export interface Project {
  dir: string;
  edit(rel: string, f: (s: string) => string): void;
}

export interface AssembleOptions {
  /** `// @@WITNESS_PAIRS@@` body for Witness.t.sol (default: the fixture's witness-pairs.part.sol, token only). */
  witnessPairs?: string;
  /** body per k for `// @@REPLAY_CALLS_<k>@@` in Replay.t.sol (keys: k). */
  replayCalls?: Record<number, string>;
}

/**
 * Project with Seance.t.sol, Witness.t.sol and Replay.t.sol filled from the fixture parts.
 * Witness and Replay are written only for the token fixture.
 */
export function assemble(kind: Kind, opts: AssembleOptions = {}): Project {
  const dir = mkdtempSync(join(tmpdir(), "exhume-templates-"));
  const fx = kind === "token" ? TOKEN_FIXTURE : WALLET_FIXTURE;
  const name = kind === "token" ? "Token" : "Wallet";
  mkdirSync(join(dir, "src/legacy"), { recursive: true });
  mkdirSync(join(dir, "src/port"), { recursive: true });
  mkdirSync(join(dir, "test/handler"), { recursive: true });
  if (kind === "token") {
    cpSync(join(DOCKER_TOKEN, "src/legacy/LegacyToken.sol"), join(dir, "src/legacy/LegacyToken.sol"));
    cpSync(join(DOCKER_TOKEN, "src/port/PortToken.sol"), join(dir, "src/port/PortToken.sol"));
    cpSync(join(fx, "HandlerUnit.t.sol"), join(dir, "test/HandlerUnit.t.sol"));
  } else {
    cpSync(join(fx, "LegacyWallet.sol"), join(dir, "src/legacy/LegacyWallet.sol"));
    cpSync(join(fx, "PortWallet.sol"), join(dir, "src/port/PortWallet.sol"));
  }
  cpSync(join(TEMPLATES, "Classifier.sol"), join(dir, "test/handler/Classifier.sol"));
  cpSync(join(fx, "Targets.sol"), join(dir, "test/handler/Targets.sol"));
  let handler = read(join(TEMPLATES, "Handler.sol"));
  handler = fillMarker(handler, "SEED_ENCODER", read(join(fx, "seed-encoder.part.sol")));
  handler = fillMarker(handler, "HANDLER_FUNCTIONS", read(join(fx, "handler-functions.part.sol")));
  writeFileSync(join(dir, "test/handler/DifferentialHandler.sol"), handler);

  const selectors = read(join(fx, "handler-selectors.part.sol"));
  writeFileSync(
    join(dir, "test/Seance.t.sol"),
    fillMarker(read(join(TEMPLATES, "Seance.t.sol")), "HANDLER_SELECTORS", selectors),
  );
  if (kind === "token") {
    let w = fillMarker(read(join(TEMPLATES, "Witness.t.sol")), "HANDLER_SELECTORS", selectors);
    w = fillMarker(w, "WITNESS_PAIRS", opts.witnessPairs ?? read(join(fx, "witness-pairs.part.sol")));
    writeFileSync(join(dir, "test/Witness.t.sol"), w);
    let r = read(join(TEMPLATES, "Replay.t.sol"));
    const calls = opts.replayCalls ?? { 1: read(join(fx, "replay-calls-1.part.sol")) };
    for (const [k, body] of Object.entries(calls)) r = fillMarker(r, `REPLAY_CALLS_${k}`, body);
    writeFileSync(join(dir, "test/Replay.t.sol"), r);
  }

  const toml = renderFoundryToml({
    contractName: name,
    legacySolcVersion: "0.4.19",
    legacyOptimizer: { enabled: false },
    forgeStdDir: LOCAL_STD,
  });
  if (!toml.ok) throw new Error(toml.error.message);
  writeFileSync(join(dir, "foundry.toml"), toml.value);
  writeFileSync(join(dir, "remappings.txt"), remappingsText(LOCAL_STD));
  return {
    dir,
    edit(rel, f) {
      const p = join(dir, rel);
      writeFileSync(p, f(read(p)));
    },
  };
}

export interface Run {
  status: number | null;
  output: string;
  /** parsed stdout when `--json` was passed */
  json?: unknown;
}

export function runForge(p: Project, args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync("forge", ["test", "--offline", ...args], {
    cwd: p.dir,
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

export function readRecords(p: Project, file: string): RecordLine[] {
  const f = join(p.dir, file);
  if (!existsSync(f)) return [];
  return read(f)
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as RecordLine);
}

export interface JsonCall {
  func_name: string;
  calldata: string;
  sender: string;
}
export interface Counterexample {
  originalLength: number;
  calls: JsonCall[];
}

/** First `invariant_witness` result of a `forge test --json` document, or undefined. */
export function witnessResult(json: unknown): { status: string; counterexample: unknown } | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  for (const entry of Object.values(json as Record<string, { test_results?: Record<string, unknown> }>)) {
    for (const [name, res] of Object.entries(entry.test_results ?? {})) {
      if (name.startsWith("invariant_witness")) return res as { status: string; counterexample: unknown };
    }
  }
  return undefined;
}

/** `counterexample.Sequence`: [originalLength, calls], or undefined for `null`. */
export function parseCx(json: unknown): Counterexample | undefined {
  const cx = witnessResult(json)?.counterexample as { Sequence?: [number, JsonCall[]] } | null | undefined;
  if (!cx || !cx.Sequence) return undefined;
  return { originalLength: cx.Sequence[0], calls: cx.Sequence[1] };
}

/**
 * HAND-WRITTEN decoder (the generator's version is task 8.5): turns a token-fixture handler
 * call (every handler argument is one 32-byte word) into `handler.<func_name>(<decimal words>);`.
 */
export function callStatement(c: JsonCall): string {
  const body = c.calldata.slice(10);
  const words: string[] = [];
  for (let i = 0; i < body.length; i += 64) words.push(BigInt("0x" + body.slice(i, i + 64)).toString());
  return `        handler.${c.func_name}(${words.join(", ")});`;
}
