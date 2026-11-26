/**
 * Task 8.8 (A): runs templates/Classifier.sol against the shared vectors
 * (engine/test/vectors/classification.json) with forge. The forge test (forge/ClassifierParity.t.sol)
 * reads the JSON at runtime; this file lays out a scratch project, passes the number of `both`
 * vectors counted here (EXPECTED_VECTORS), and proves that the parity test can fail.
 * Nothing here depends on the host: the same project layout works with FORGE_STD_DIR=/opt/forge-std in Docker.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { remappingsText } from "../../src/seance/forge-std-pin.js";
import { ENGINE, FORGE_TIMEOUT, LOCAL_STD, TEMPLATES, HERE, skipReason } from "./template-project.js";

const VECTORS = join(ENGINE, "test/vectors/classification.json");
interface Vec {
  name: string;
  scope?: string;
  expect: { differingFields: string[] };
}
const doc = JSON.parse(readFileSync(VECTORS, "utf8")) as { vectors: Vec[] };
const bothVectors = doc.vectors.filter((v) => (v.scope ?? "both") === "both");
const tsOnly = doc.vectors.length - bothVectors.length;

interface Opts {
  vectorsText?: string;
  classifierEdit?: (s: string) => string;
}
function project(o: Opts = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "exhume-parity-"));
  mkdirSync(join(dir, "test/handler"), { recursive: true });
  mkdirSync(join(dir, "vectors"), { recursive: true });
  const cls = readFileSync(join(TEMPLATES, "Classifier.sol"), "utf8");
  writeFileSync(join(dir, "test/handler/Classifier.sol"), o.classifierEdit ? o.classifierEdit(cls) : cls);
  cpSync(join(HERE, "forge/ClassifierParity.t.sol"), join(dir, "test/ClassifierParity.t.sol"));
  writeFileSync(join(dir, "vectors/classification.json"), o.vectorsText ?? readFileSync(VECTORS, "utf8"));
  writeFileSync(
    join(dir, "foundry.toml"),
    [
      "[profile.default]",
      'src = "src"',
      'out = "out"',
      'solc = "0.8.28"',
      `allow_paths = ["${LOCAL_STD}"]`,
      'fs_permissions = [{ access = "read", path = "./vectors" }]',
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "remappings.txt"), remappingsText(LOCAL_STD));
  return dir;
}
function run(dir: string): { status: number | null; out: string } {
  const r = spawnSync("forge", ["test", "--offline", "-vv"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, EXPECTED_VECTORS: String(bothVectors.length) },
    timeout: FORGE_TIMEOUT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe.skipIf(skipReason !== "")(`Classifier.sol parity with the shared vectors (${skipReason || "native forge"})`, () => {
  it("has both-scope vectors and ts-only vectors to skip", () => {
    expect(bothVectors.length).toBeGreaterThan(0);
    expect(tsOnly).toBeGreaterThan(0);
  });

  it(
    "runs every both-scope vector and skips the ts-only ones",
    () => {
      const dir = project();
      try {
        const r = run(dir);
        expect(r.status, r.out.slice(-3000)).toBe(0);
        expect(r.out).toMatch(new RegExp(`PARITY_VECTORS_RUN:\\s+${bothVectors.length}\\b`));
        expect(r.out).toMatch(new RegExp(`PARITY_VECTORS_SKIPPED:\\s+${tsOnly}\\b`));
        expect(r.out).toMatch(new RegExp(`PARITY_VECTORS_TOTAL:\\s+${doc.vectors.length}\\b`));
        expect(r.out).toMatch(/1 passed; 0 failed/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    FORGE_TIMEOUT,
  );

  it(
    "negative check: a changed expected differingFields fails and names the vector",
    () => {
      const target = bothVectors.find((v) => v.expect.differingFields.length > 0)!;
      const mutated = structuredClone(doc);
      const m = mutated.vectors.find((v) => v.name === target.name)!;
      m.expect.differingFields = [...m.expect.differingFields, "state.zzz"];
      const dir = project({ vectorsText: JSON.stringify(mutated) });
      try {
        const r = run(dir);
        expect(r.status).not.toBe(0);
        expect(r.out).toContain(`differingFields differ in vector: ${target.name}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    FORGE_TIMEOUT,
  );

  it(
    "negative check: a classifier that treats Panic(0x12) as exorcised fails and names the vector",
    () => {
      const dir = project({
        classifierEdit: (s) => {
          expect(s).toContain("return d[35] == 0x11;");
          return s.replace("return d[35] == 0x11;", "return d[35] == 0x11 || d[35] == 0x12;");
        },
      });
      try {
        const r = run(dir);
        expect(r.status).not.toBe(0);
        expect(r.out).toMatch(/classification differs in vector: \S+/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    FORGE_TIMEOUT,
  );
});
