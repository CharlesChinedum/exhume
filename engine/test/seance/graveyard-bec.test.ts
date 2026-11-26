/**
 * Task 13.0: checks the hand-written BEC golden port and Autopsy report in graveyard/bec/.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { compareAbis } from "../../src/seance/abi-compat.js";
import { loadAbi } from "../../src/seance/abi.js";
import { parseAutopsyReport } from "../../src/seance/autopsy-contract.js";
import { compareRuntimeCode } from "../../src/seance/bytecode.js";
import { renderFoundryToml } from "../../src/seance/foundry-config.js";
import { remappingsText } from "../../src/seance/forge-std-pin.js";
import { generateTargets } from "../../src/seance/input-generator.js";
import schema from "../../src/seance/schemas/autopsy-v1.schema.json" with { type: "json" };
import type { AbiFunction } from "../../src/seance/types.js";
import { ENGINE, FORGE_TIMEOUT, LOCAL_STD, skipReason } from "./template-project.js";

const BEC = resolve(ENGINE, "../graveyard/bec");
const read = (f: string): string => readFileSync(join(BEC, f), "utf8");

function legacyAbi(): AbiFunction[] {
  const r = loadAbi(JSON.parse(read("abi.json")));
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("graveyard/bec autopsy.json", () => {
  const text = read("autopsy.json");

  it("validates against the Autopsy schema", () => {
    const ajv = new Ajv2020.default({ allErrors: true, strict: true });
    const validate = ajv.compile(schema as object);
    expect(validate(JSON.parse(text)), JSON.stringify(validate.errors)).toBe(true);
  });

  it("is accepted by parseAutopsyReport against the legacy ABI", () => {
    const r = parseAutopsyReport(text, legacyAbi());
    expect(r.ok, r.ok ? "" : r.error.message).toBe(true);
  });

  it("points at the operand expression in BecToken.sol (1-based)", () => {
    const r = parseAutopsyReport(text, legacyAbi());
    if (!r.ok) throw new Error(r.error.message);
    for (const s of r.value.sites) {
      const lines = read(s.location.file).split(/\r?\n/);
      const line = lines[s.location.line - 1] as string;
      expect(line.slice(s.location.column - 1).startsWith("uint256(cnt) * _value")).toBe(true);
    }
  });

  it("yields 23 paired entries for batchTransfer, first (2, 2^255), and is reachable", () => {
    const abi = legacyAbi();
    const r = parseAutopsyReport(text, abi);
    if (!r.ok) throw new Error(r.error.message);
    const plan = generateTargets(r.value, abi);
    if (!plan.ok) throw new Error(plan.error.message);
    const site = plan.value.sites.find((s) => s.functionName === "batchTransfer");
    expect(site).toBeDefined();
    expect(site?.entries).toHaveLength(23);
    expect(site?.unreachable).toBe(false);
    const first = site?.entries[0]?.assignments.map((a) => a.value);
    expect(first).toEqual([2n, 1n << 255n]);
  });
});

describe.skipIf(skipReason !== "")(`graveyard/bec port.golden.sol (${skipReason || "native forge"})`, () => {
  it(
    "compiles under solc 0.8.28, legacy runtime code equals runtime.hex, ABIs are compatible",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "exhume-bec-"));
      try {
        mkdirSync(join(dir, "src/legacy"), { recursive: true });
        mkdirSync(join(dir, "src/port"), { recursive: true });
        cpSync(join(BEC, "BecToken.sol"), join(dir, "src/legacy/LegacyBecToken.sol"));
        cpSync(join(BEC, "port.golden.sol"), join(dir, "src/port/PortBecToken.sol"));
        const toml = renderFoundryToml({
          contractName: "BecToken",
          legacySolcVersion: "0.4.19",
          legacyOptimizer: { enabled: false },
        });
        if (!toml.ok) throw new Error(toml.error.message);
        // The generated restrictions name /opt/forge-std; point them at the local checkout.
        writeFileSync(join(dir, "foundry.toml"), toml.value.replaceAll("/opt/forge-std", LOCAL_STD));
        writeFileSync(join(dir, "remappings.txt"), remappingsText(LOCAL_STD));
        const b = spawnSync("forge", ["build", "--offline"], {
          cwd: dir,
          encoding: "utf8",
          timeout: FORGE_TIMEOUT,
          maxBuffer: 64 * 1024 * 1024,
        });
        const out = (b.stdout ?? "") + (b.stderr ?? "");
        expect(b.status, out.slice(-3000)).toBe(0);

        const art = (p: string) => JSON.parse(readFileSync(join(dir, "out", p, "BecToken.json"), "utf8")) as {
          abi: unknown;
          deployedBytecode: { object: string };
        };
        const legacy = art("LegacyBecToken.sol");
        const port = art("PortBecToken.sol");
        const cmp = compareRuntimeCode(legacy.deployedBytecode.object, read("runtime.hex").trim());
        expect(cmp.ok, cmp.ok ? "" : cmp.error.message).toBe(true);
        const portAbi = loadAbi(port.abi);
        if (!portAbi.ok) throw new Error(portAbi.error.message);
        const abiCmp = compareAbis(legacyAbi(), portAbi.value);
        expect(abiCmp.ok, abiCmp.ok ? "" : abiCmp.error.message).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    FORGE_TIMEOUT,
  );
});
