/** Task 13.1: the graveyard loader, on the real BEC entry and on temp entries. */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAbi } from "../../src/seance/abi.js";
import { parseAutopsyReport } from "../../src/seance/autopsy-contract.js";
import { loadGraveyardInput } from "../../src/seance/graveyard.js";
import { MAX_SOURCE_BYTES, validateInput } from "../../src/seance/inputs.js";
import { ENGINE } from "./template-project.js";

const GRAVEYARD = resolve(ENGINE, "../graveyard");
const BEC = join(GRAVEYARD, "bec");
const FILES = ["BecToken.sol", "port.golden.sol", "autopsy.json", "runtime.hex", "metadata.json", "abi.json"];

const cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A temp graveyard with a copy of the BEC entry named `x`. */
function tempEntry(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "exhume-grave-"));
  cleanup.push(root);
  const dir = join(root, "x");
  mkdirSync(dir);
  for (const f of FILES) copyFileSync(join(BEC, f), join(dir, f));
  return { root, dir };
}
const failure = (root: string) => {
  const r = loadGraveyardInput(root, "x");
  if (r.ok) throw new Error("expected failure");
  return r.error;
};

describe("loadGraveyardInput on graveyard/bec", () => {
  const r = loadGraveyardInput(GRAVEYARD, "bec");
  if (!r.ok) throw new Error(r.error.message);
  const v = r.value;

  it("fills the input from the entry", () => {
    expect(v.contractName).toBe("BecToken");
    expect(v.legacySolcVersion).toBe("0.4.19");
    expect(v.legacyOptimizer).toBe(false);
    expect("legacyOptimizerRuns" in v).toBe(false);
    expect(v.constructorArgs).toBe("0x");
    expect(v.timeoutSeconds).toBe(300);
  });

  it("uses the file contents as they are, CRLF included", () => {
    const legacy = readFileSync(join(BEC, "BecToken.sol"));
    expect(Buffer.from(v.legacySource, "utf8").equals(legacy)).toBe(true);
    expect(v.portSource).toBe(readFileSync(join(BEC, "port.golden.sol"), "utf8"));
    expect(v.autopsyReport).toBe(readFileSync(join(BEC, "autopsy.json"), "utf8"));
  });

  it("normalises runtime.hex to 0x lowercase hex", () => {
    const text = readFileSync(join(BEC, "runtime.hex"), "utf8").trim().replace(/^0x/i, "").toLowerCase();
    expect(v.onChainRuntimeCode.startsWith("0x")).toBe(true);
    expect(v.onChainRuntimeCode).toBe("0x" + text);
    expect(v.onChainRuntimeCode).toMatch(/^0x(?:[0-9a-f]{2})+$/);
  });

  it("carries an autopsy that parses against abi.json", () => {
    const abi = loadAbi(JSON.parse(readFileSync(join(BEC, "abi.json"), "utf8")));
    if (!abi.ok) throw new Error(abi.error.message);
    const a = parseAutopsyReport(v.autopsyReport, abi.value);
    expect(a.ok).toBe(true);
  });

  it("passes validateInput and stays within the source limit", () => {
    expect(validateInput(v).ok).toBe(true);
    for (const f of ["BecToken.sol", "port.golden.sol"]) expect(statSync(join(BEC, f)).size).toBeLessThanOrEqual(MAX_SOURCE_BYTES);
  });

  it("is deterministic and passes options through", () => {
    expect(loadGraveyardInput(GRAVEYARD, "bec")).toEqual(r);
    const o = loadGraveyardInput(GRAVEYARD, "bec", { fuzzSeed: "42", timeoutSeconds: 120 });
    expect(o.ok && o.value.fuzzSeed).toBe("42");
    expect(o.ok && o.value.timeoutSeconds).toBe(120);
  });
});

describe("loadGraveyardInput errors and normalisation", () => {
  it.each(["runtime.hex", "metadata.json", "port.golden.sol", "autopsy.json", "BecToken.sol"])("missing %s", (f) => {
    const { root, dir } = tempEntry();
    rmSync(join(dir, f));
    const e = failure(root);
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.message).toContain(f);
    expect(e.message).toMatch(/^[\x20-\x7e]*$/);
  });

  it("rejects bad metadata", () => {
    const { root, dir } = tempEntry();
    writeFileSync(join(dir, "metadata.json"), "{not json");
    expect(failure(root).code).toBe("INVALID_INPUT");
    writeFileSync(join(dir, "metadata.json"), JSON.stringify({ compiler: { version: "nope" }, settings: {} }));
    expect(failure(root).code).toBe("INVALID_INPUT");
  });

  it("rejects metadata without optimizer settings or a plain compilation target", () => {
    const { root, dir } = tempEntry();
    const m = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8"));
    const noOpt = structuredClone(m);
    delete noOpt.settings.optimizer;
    writeFileSync(join(dir, "metadata.json"), JSON.stringify(noOpt));
    expect(failure(root).message).toContain("optimizer");
    const trav = structuredClone(m);
    trav.settings.compilationTarget = { "../BecToken.sol": "BecToken" };
    writeFileSync(join(dir, "metadata.json"), JSON.stringify(trav));
    expect(failure(root).message).toContain("compilationTarget");
  });

  it("reads optimizer runs when the optimizer is enabled", () => {
    const { root, dir } = tempEntry();
    const m = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8"));
    m.settings.optimizer = { enabled: true, runs: 200 };
    writeFileSync(join(dir, "metadata.json"), JSON.stringify(m));
    const r = loadGraveyardInput(root, "x");
    expect(r.ok && r.value.legacyOptimizer).toBe(true);
    expect(r.ok && r.value.legacyOptimizerRuns).toBe(200);
  });

  it("normalises runtime.hex: uppercase, existing 0x, trailing newline", () => {
    const { root, dir } = tempEntry();
    const base = readFileSync(join(BEC, "runtime.hex"), "utf8").trim().replace(/^0x/, "");
    const want = "0x" + base.toLowerCase();
    for (const text of [base.toUpperCase(), "0x" + base, "0x" + base.toUpperCase() + "\r\n", "  " + base + "\n\n"]) {
      writeFileSync(join(dir, "runtime.hex"), text);
      const r = loadGraveyardInput(root, "x");
      expect(r.ok && r.value.onChainRuntimeCode).toBe(want);
    }
  });

  it("rejects an invalid runtime.hex and unsafe entry names", () => {
    const { root, dir } = tempEntry();
    writeFileSync(join(dir, "runtime.hex"), "0xabc\n");
    expect(failure(root).code).toBe("INVALID_INPUT");
    const bad = loadGraveyardInput(root, "../x");
    expect(!bad.ok && bad.error.code).toBe("INVALID_INPUT");
  });
});
