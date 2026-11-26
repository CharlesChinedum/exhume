import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { renderFoundryToml, type FoundryConfigOptions } from "../../src/seance/foundry-config.js";
import {
  FORGE_STD_PIN,
  INVARIANT_DEPTH,
  INVARIANT_RUNS,
  PORT_SOLC_VERSION,
  allowPathsToml,
  remappingsText,
} from "../../src/seance/forge-std-pin.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCKER = resolve(HERE, "../docker");

interface Restriction {
  paths: string;
  version: string;
  [k: string]: unknown;
}
interface Parsed {
  solc?: unknown;
  profile: { default: Record<string, unknown> & { compilation_restrictions: Restriction[]; invariant: Record<string, unknown> } };
}

function render(o: Partial<FoundryConfigOptions> = {}): string {
  const r = renderFoundryToml({
    contractName: "Token",
    legacySolcVersion: "0.4.19",
    legacyOptimizer: { enabled: false },
    ...o,
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
const toml = (s: string): Parsed => parse(s) as unknown as Parsed;

describe("forge-std-pin", () => {
  it("FORGE_STD_PIN equals the Docker pin file", () => {
    expect(FORGE_STD_PIN).toBe(readFileSync(join(DOCKER, "FORGE_STD_PIN"), "utf8").trim());
  });
  it("remappings and allow_paths text", () => {
    expect(remappingsText()).toBe("forge-std/=/opt/forge-std/src/\n");
    expect(remappingsText("/x/y")).toBe("forge-std/=/x/y/src/\n");
    expect(allowPathsToml("/x/y")).toBe('allow_paths = ["/x/y"]');
    expect(() => remappingsText("/x/y/")).toThrow();
    expect(() => remappingsText('/x"y')).toThrow();
    expect(() => remappingsText("rel")).toThrow();
  });
});

describe("renderFoundryToml", () => {
  it("optimizer disabled: no profile, no min_optimizer_runs, exact legacy pin", () => {
    const text = render();
    const p = toml(text).profile.default;
    expect(toml(text).solc).toBeUndefined();
    expect(p.solc).toBeUndefined();
    expect(p.additional_compiler_profiles).toBeUndefined();
    expect(p.optimizer).toBe(false);
    expect(p.optimizer_runs).toBe(1);
    expect(p.compilation_restrictions).toEqual([
      { paths: "src/legacy/LegacyToken.sol", version: "=0.4.19" },
      { paths: "src/port/PortToken.sol", version: "=0.8.28" },
      { paths: "/opt/forge-std/src/**", version: "=0.8.28" },
      { paths: "test/**", version: "=0.8.28" },
    ]);
    expect(text).not.toContain("min_optimizer_runs");
    expect(text).not.toMatch(/version = "0\.4\.19"/);
  });

  it.each([
    [200, 1],
    [1, 2],
    [0, 1],
  ])("optimizer enabled R=%i gives default optimizer_runs=%i", (R, r0) => {
    const p = toml(render({ legacyOptimizer: { enabled: true, runs: R } })).profile.default;
    expect(p.optimizer_runs).toBe(r0);
    expect(p.additional_compiler_profiles).toEqual([{ name: "legacy_opt", optimizer: true, optimizer_runs: R }]);
    expect(p.compilation_restrictions[0]).toEqual({
      paths: "src/legacy/LegacyToken.sol",
      version: "=0.4.19",
      min_optimizer_runs: R,
    });
    expect(p.compilation_restrictions[1]).toEqual({ paths: "src/port/PortToken.sol", version: "=0.8.28" });
  });

  it("portSharesLegacyOptimizer adds min_optimizer_runs to the port only when enabled", () => {
    const on = toml(render({ legacyOptimizer: { enabled: true, runs: 200 }, portSharesLegacyOptimizer: true }));
    expect(on.profile.default.compilation_restrictions[1]).toEqual({
      paths: "src/port/PortToken.sol",
      version: "=0.8.28",
      min_optimizer_runs: 200,
    });
    const off = render({ legacyOptimizer: { enabled: false }, portSharesLegacyOptimizer: true });
    expect(off).not.toContain("min_optimizer_runs");
  });

  it("fixed settings: fs_permissions, allow_paths, gas_limit, invariant", () => {
    const p = toml(render({ forgeStdDir: "/srv/fs" })).profile.default;
    expect(p.allow_paths).toEqual(["/srv/fs"]);
    expect(p.fs_permissions).toEqual([
      { access: "read", path: "./out" },
      { access: "read-write", path: "./seance-out" },
    ]);
    expect(p.gas_limit).toBe(1_000_000_000);
    expect(p.invariant).toEqual({
      runs: INVARIANT_RUNS,
      depth: INVARIANT_DEPTH,
      fail_on_revert: true,
      shrink_run_limit: 0,
    });
    expect(p.compilation_restrictions.slice(2)).toEqual([
      { paths: "/srv/fs/src/**", version: `=${PORT_SOLC_VERSION}` },
      { paths: "test/**", version: `=${PORT_SOLC_VERSION}` },
    ]);
  });

  it("is deterministic, LF only, trailing newline; dirs do not leak", () => {
    const o = { legacyOptimizer: { enabled: true, runs: 200 } };
    expect(render(o)).toBe(render(o));
    const a = render({ ...o, forgeStdDir: "/dir/a" });
    const b = render({ ...o, forgeStdDir: "/dir/b" });
    expect(a).toContain("/dir/a");
    expect(a).not.toContain("/dir/b");
    expect(b).toContain("/dir/b");
    expect(b).not.toContain("/dir/a");
    for (const t of [a, b, render()]) {
      expect(t).not.toContain("\r");
      expect(t.endsWith("\n")).toBe(true);
      expect(t).not.toContain("/Users/");
      expect(t).not.toContain("engine/test/docker/.cache");
    }
    expect(render()).toContain("/opt/forge-std");
  });

  it("rejects bad input", () => {
    for (const contractName of ["", "1A", 'A"B', "A B", "A\\B", "A\nB", "A-B"]) {
      const r = renderFoundryToml({ contractName, legacySolcVersion: "0.4.19", legacyOptimizer: { enabled: false } });
      expect(r.ok).toBe(false);
    }
    for (const legacySolcVersion of ["0.4", "=0.4.19", "^0.4.19", "0.4.19-x", "0.4.x"]) {
      expect(renderFoundryToml({ contractName: "T", legacySolcVersion, legacyOptimizer: { enabled: false } }).ok).toBe(false);
    }
    for (const runs of [undefined, -1, 1.5, 4294967296]) {
      const o = { contractName: "T", legacySolcVersion: "0.4.19", legacyOptimizer: { enabled: true, ...(runs !== undefined && { runs }) } };
      expect(renderFoundryToml(o).ok).toBe(false);
    }
    expect(renderFoundryToml({ contractName: "T", legacySolcVersion: "0.4.19", legacyOptimizer: { enabled: false }, forgeStdDir: "/a/" }).ok).toBe(false);
  });

  it("invariants hold for random inputs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 7 }),
        fc.integer({ min: 0, max: 30 }),
        fc.boolean(),
        fc.oneof(fc.constant(1), fc.constant(0), fc.constant(200), fc.integer({ min: 0, max: 4294967295 })),
        fc.boolean(),
        (minor, patch, enabled, R, share) => {
          const v = `0.${minor}.${patch}`;
          const text = render({
            legacySolcVersion: v,
            legacyOptimizer: enabled ? { enabled, runs: R } : { enabled },
            portSharesLegacyOptimizer: share,
          });
          const p = toml(text).profile.default;
          const rs = p.compilation_restrictions;
          expect(p.solc).toBeUndefined();
          expect(rs[0]!.version).toBe(`=${v}`);
          expect(rs[1]!.version).toBe("=0.8.28");
          for (const r of rs) for (const k of ["profile", "settings", "optimizer"]) expect(r).not.toHaveProperty(k);
          if (enabled) {
            expect(p.optimizer_runs).not.toBe(R);
            expect(rs[0]!.min_optimizer_runs).toBe(R);
            expect(rs[1]!.min_optimizer_runs).toBe(share ? R : undefined);
            expect(p.additional_compiler_profiles).toEqual([{ name: "legacy_opt", optimizer: true, optimizer_runs: R }]);
          } else {
            expect(text).not.toContain("min_optimizer_runs");
            expect(p.additional_compiler_profiles).toBeUndefined();
            expect(p.optimizer).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---- end-to-end smoke with real forge ----
const forgeOk = spawnSync("forge", ["--version"], { encoding: "utf8" }).status === 0;
const localStd = join(DOCKER, ".cache/forge-std");
const stdOk = existsSync(join(localStd, "src/Test.sol"));
const skipReason = !forgeOk ? "forge not on PATH" : !stdOk ? `forge-std checkout missing at ${localStd}` : "";

describe("forge build smoke", () => {
  it.skipIf(skipReason !== "")(`renders a foundry.toml that forge 1.5.1 builds (${skipReason || "runs"})`, () => {
    for (const enabled of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), "exhume-foundry-"));
      try {
        cpSync(join(DOCKER, "fixtures/token"), dir, { recursive: true });
        writeFileSync(
          join(dir, "foundry.toml"),
          render({ forgeStdDir: localStd, legacyOptimizer: enabled ? { enabled, runs: 200 } : { enabled } }),
        );
        writeFileSync(join(dir, "remappings.txt"), remappingsText(localStd));
        const b = spawnSync("forge", ["build", "--offline"], { cwd: dir, encoding: "utf8" });
        expect(b.status, b.stdout + b.stderr).toBe(0);
        const meta = (f: string) =>
          JSON.parse(readFileSync(join(dir, "out", f), "utf8")).metadata as {
            compiler: { version: string };
            settings: { optimizer: { enabled: boolean; runs: number } };
          };
        const legacy = meta("LegacyToken.sol/Token.json");
        const port = meta("PortToken.sol/Token.json");
        expect(legacy.compiler.version.startsWith("0.4.19+")).toBe(true);
        expect(legacy.settings.optimizer.enabled).toBe(enabled);
        if (enabled) expect(legacy.settings.optimizer.runs).toBe(200);
        expect(port.compiler.version.startsWith("0.8.28+")).toBe(true);
        expect(port.settings.optimizer.enabled).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 120_000);
});

