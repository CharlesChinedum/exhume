import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), "../../src/seance/templates/Classifier.sol");
const forgeOnPath = spawnSync("forge", ["--version"], { encoding: "utf8" }).status === 0;

/** Removes comments so the text checks look at code only. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("Classifier.sol template", () => {
  it("exists at the design path", () => {
    expect(existsSync(TEMPLATE)).toBe(true);
  });

  it("pins pragma solidity 0.8.28", () => {
    expect(readFileSync(TEMPLATE, "utf8")).toMatch(/^pragma solidity 0\.8\.28;$/m);
  });

  it("has no impure constructs", () => {
    const code = stripComments(readFileSync(TEMPLATE, "utf8"));
    expect(code).not.toMatch(/\bblock\./);
    expect(code).not.toMatch(/\bmsg\./);
    expect(code).not.toMatch(/\btx\./);
    expect(code).not.toMatch(/\bsload\b|\bsstore\b|\bassembly\b/);
    expect(code).not.toMatch(/\.(call|delegatecall|staticcall|send|transfer)\s*[({]/);
    expect(code).not.toMatch(/\bexternal\b|\bpayable\b/);
  });

  it.skipIf(!forgeOnPath)(
    "compiles with forge build --offline",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "classifier-template-"));
      try {
        mkdirSync(join(dir, "src"));
        cpSync(TEMPLATE, join(dir, "src/Classifier.sol"));
        writeFileSync(join(dir, "foundry.toml"), '[profile.default]\nsolc = "0.8.28"\noptimizer = false\n');
        const r = spawnSync("forge", ["build", "--offline"], { cwd: dir, encoding: "utf8" });
        expect(r.stdout + r.stderr).toContain("Compiler run successful");
        expect(r.status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
