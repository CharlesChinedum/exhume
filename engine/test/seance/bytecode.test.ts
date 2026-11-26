import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkSolcPresent,
  compareRuntimeCode,
  hashRuntimeCode,
  listInstalledSolc,
  readLegacyArtifact,
  stripMetadataSuffix,
  svmRoots,
} from "../../src/seance/bytecode.js";
import { renderFoundryToml } from "../../src/seance/foundry-config.js";
import { remappingsText } from "../../src/seance/forge-std-pin.js";
import { DOCKER_TOKEN, LOCAL_STD, skipReason } from "./template-project.js";
import type { Result } from "../../src/seance/types.js";

const val = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

// ---- synthetic code ----
const SUFFIX_LEGACY = "a165627a7a72305820" + "8b".repeat(32) + "0029"; // 43 bytes
const body = "6080604052" + "00".repeat(20);

describe("stripMetadataSuffix (synthetic)", () => {
  it("strips a 43-byte bzzr0 suffix", () => {
    expect(val(stripMetadataSuffix("0x" + body + SUFFIX_LEGACY))).toBe("0x" + body);
  });
  it("strips a 53-byte solc 0.8.28 suffix", () => {
    const s = "a2646970667358221220" + "d7".repeat(32) + "64736f6c634300081c0033";
    expect(s.length / 2).toBe(53);
    expect(val(stripMetadataSuffix(body + s))).toBe("0x" + body);
  });
  it("returns code without a recognisable suffix unchanged", () => {
    expect(val(stripMetadataSuffix("0x" + body))).toBe("0x" + body); // last two bytes 0000 -> L+2 = 2, first byte not CBOR
    expect(val(stripMetadataSuffix("0x6080604052fe"))).toBe("0x6080604052fe"); // L too large
    expect(val(stripMetadataSuffix("0x60"))).toBe("0x60");
  });
  it("keeps code unchanged when the suffix would consume everything", () => {
    const only = "a1" + "00".repeat(40) + "0029"; // 43 bytes: L+2 == code length
    expect(only.length / 2).toBe(43);
    expect(val(stripMetadataSuffix(only))).toBe("0x" + only);
  });
  it("normalises case and prefix", () => {
    const lower = val(stripMetadataSuffix("0x" + body + SUFFIX_LEGACY));
    expect(val(stripMetadataSuffix("0X" + (body + SUFFIX_LEGACY).toUpperCase()))).toBe(lower);
    expect(val(stripMetadataSuffix(body + SUFFIX_LEGACY))).toBe(lower);
  });
  it("rejects odd length, non-hex and empty code", () => {
    for (const bad of ["0x123", "0x", "", "0xzz", "0x12 34"]) {
      const r = stripMetadataSuffix(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    }
  });
  it("hashRuntimeCode ignores the suffix and is keccak-256", () => {
    const h = val(hashRuntimeCode("0x" + body + SUFFIX_LEGACY));
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(val(hashRuntimeCode("0x" + body + SUFFIX_LEGACY.replace(/8b/g, "11")))).toBe(h);
    expect(val(hashRuntimeCode("0x" + body + "00"))).not.toBe(h);
    // keccak256 of the empty-looking single byte 0x00 is a known vector
    expect(val(hashRuntimeCode("0x00"))).toBe("0xbc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a");
  });
});

describe("compareRuntimeCode (property)", () => {
  const bodyArb = fc.uint8Array({ minLength: 4, maxLength: 80 }).map((b) => Buffer.from(b).toString("hex"));
  const suffixArb = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((h) => "a165627a7a72305820" + Buffer.from(h).toString("hex") + "0029");

  it("equal bodies with any two suffixes compare equal", () => {
    fc.assert(
      fc.property(bodyArb, suffixArb, suffixArb, (b, s1, s2) => {
        expect(compareRuntimeCode("0x" + b + s1, "0x" + b + s2).ok).toBe(true);
      }),
    );
  });
  it("bodies differing in one byte mismatch", () => {
    fc.assert(
      fc.property(bodyArb, suffixArb, fc.nat(), (b, s, k) => {
        const i = k % (b.length / 2);
        const byte = (parseInt(b.slice(2 * i, 2 * i + 2), 16) ^ 1).toString(16).padStart(2, "0");
        const b2 = b.slice(0, 2 * i) + byte + b.slice(2 * i + 2);
        const r = compareRuntimeCode("0x" + b + s, "0x" + b2 + s);
        expect(r.ok).toBe(false);
      }),
    );
  });
});

describe("compareRuntimeCode (synthetic)", () => {
  it("BYTECODE_MISMATCH reports both hashes and lengths", () => {
    const r = compareRuntimeCode("0x" + body + SUFFIX_LEGACY, "0x" + body.replace("6080", "6081") + SUFFIX_LEGACY);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("BYTECODE_MISMATCH");
    const d = r.error.details as { compiled: { hash: string; length: number }; onChain: { hash: string; length: number } };
    expect(d.compiled.hash).not.toBe(d.onChain.hash);
    expect(d.compiled.length).toBe(body.length / 2);
    expect(r.error.message).toContain(d.compiled.hash);
    expect(r.error.message).toContain(d.onChain.hash);
  });
  it("invalid input is INVALID_INPUT, not a mismatch", () => {
    const r = compareRuntimeCode("0x123", "0x00");
    expect(!r.ok && r.error.code).toBe("INVALID_INPUT");
  });
});

// ---- solc presence ----
describe("checkSolcPresent / listInstalledSolc", () => {
  it("present and missing with injected lists", async () => {
    expect((await checkSolcPresent("0.4.19", ["0.4.19", "0.8.28"])).ok).toBe(true);
    expect((await checkSolcPresent("0.4.19", async () => ["0.4.19"])).ok).toBe(true);
    const r = await checkSolcPresent("0.4.19", ["0.4.26"]);
    expect(!r.ok && r.error.code).toBe("SOLC_MISSING");
    if (!r.ok) expect(r.error.message).toContain("0.4.19");
    const r2 = await checkSolcPresent("0.5.1", async () => []);
    expect(!r2.ok && r2.error.code).toBe("SOLC_MISSING");
  });
  it("lists a fake svm tree and only counts directories with the binary", async () => {
    const root = mkdtempSync(join(tmpdir(), "exhume-svm-"));
    try {
      mkdirSync(join(root, "0.4.19"));
      writeFileSync(join(root, "0.4.19", "solc-0.4.19"), "");
      mkdirSync(join(root, "0.8.28"));
      writeFileSync(join(root, "0.8.28", "solc-0.8.28"), "");
      mkdirSync(join(root, "0.7.6")); // empty install dir: not installed
      writeFileSync(join(root, ".global-version"), "");
      expect(listInstalledSolc([root, join(root, "nonexistent")])).toEqual(["0.4.19", "0.8.28"]);
      expect((await checkSolcPresent("0.4.19", async () => listInstalledSolc([root]))).ok).toBe(true);
      const miss = await checkSolcPresent("0.7.6", async () => listInstalledSolc([root]));
      expect(!miss.ok && miss.error.code).toBe("SOLC_MISSING");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("svmRoots honours SVM_HOME first", () => {
    expect(svmRoots({ SVM_HOME: "/x/svm" }, "/h")[0]).toBe("/x/svm");
    expect(svmRoots({}, "/h")).toContain("/h/.svm");
  });
  const real = listInstalledSolc();
  it.skipIf(real.length === 0)("finds the real local solc installs", () => {
    expect(real.every((v) => /^\d+\.\d+\.\d+$/.test(v))).toBe(true);
  });
});

// ---- readLegacyArtifact (synthetic) ----
describe("readLegacyArtifact", () => {
  let out: string;
  const put = (content: unknown) => {
    mkdirSync(join(out, "LegacyT.sol"), { recursive: true });
    writeFileSync(join(out, "LegacyT.sol", "T.json"), typeof content === "string" ? content : JSON.stringify(content));
  };
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "exhume-out-"));
  });
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("missing file names the path", () => {
    const r = readLegacyArtifact(out, "Nope");
    expect(!r.ok && r.error.code).toBe("BUILD_FAILED");
    if (!r.ok) expect(r.error.message).toContain(join(out, "LegacyNope.sol", "Nope.json"));
  });
  it("invalid JSON", () => {
    put("{not json");
    const r = readLegacyArtifact(out, "T");
    expect(!r.ok && r.error.code).toBe("BUILD_FAILED");
  });
  it("missing deployedBytecode.object", () => {
    put({ abi: [], deployedBytecode: {} });
    const r = readLegacyArtifact(out, "T");
    expect(!r.ok && r.error.code).toBe("BUILD_FAILED");
    put({ abi: [] });
    expect(readLegacyArtifact(out, "T").ok).toBe(false);
    put({ abi: [], deployedBytecode: { object: "" } });
    expect(readLegacyArtifact(out, "T").ok).toBe(false);
    put({ abi: [], deployedBytecode: { object: "6080" } }); // no 0x
    expect(readLegacyArtifact(out, "T").ok).toBe(false);
  });
  it("link placeholders are rejected", () => {
    put({ abi: [], deployedBytecode: { object: "0x6080__$abcdef0123456789abcdef0123456789ab$__6080" } });
    const r = readLegacyArtifact(out, "T");
    expect(!r.ok && r.error.code).toBe("INVALID_INPUT");
    if (!r.ok) expect(r.error.message).toMatch(/librar/);
  });
  it("good artifact: lowercased code and loaded ABI", () => {
    put({
      abi: [{ type: "function", name: "f", inputs: [], constant: true }, { type: "event", name: "E", inputs: [] }],
      deployedBytecode: { object: "0x60AB" },
    });
    const r = val(readLegacyArtifact(out, "T"));
    expect(r.runtimeCode).toBe("0x60ab");
    expect(r.abi).toHaveLength(1);
    expect(r.abi[0]!.stateMutability).toBe("view");
  });
});

// ---- real artifacts ----
describe.skipIf(skipReason !== "")(`real token fixture artifacts (${skipReason || "runs"})`, () => {
  let dir: string;
  let outDir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "exhume-bytecode-"));
    cpSync(DOCKER_TOKEN, dir, { recursive: true });
    writeFileSync(
      join(dir, "foundry.toml"),
      val(renderFoundryToml({ contractName: "Token", legacySolcVersion: "0.4.19", legacyOptimizer: { enabled: false }, forgeStdDir: LOCAL_STD })),
    );
    writeFileSync(join(dir, "remappings.txt"), remappingsText(LOCAL_STD));
    const b = spawnSync("forge", ["build", "--offline"], { cwd: dir, encoding: "utf8" });
    if (b.status !== 0) throw new Error(b.stdout + b.stderr);
    outDir = join(dir, "out");
  }, 300_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const portCode = () =>
    (JSON.parse(readFileSync(join(outDir, "PortToken.sol", "Token.json"), "utf8")) as { deployedBytecode: { object: string } })
      .deployedBytecode.object;

  it("legacy suffix is 43 bytes (0029), port suffix is 53 bytes (0033)", () => {
    const legacy = val(readLegacyArtifact(outDir, "Token")).runtimeCode;
    expect(legacy.endsWith("0029")).toBe(true);
    expect((legacy.length - 2) / 2 - (val(stripMetadataSuffix(legacy)).length - 2) / 2).toBe(43);
    const port = portCode();
    expect(port.endsWith("0033")).toBe(true);
    expect((port.length - 2) / 2 - (val(stripMetadataSuffix(port)).length - 2) / 2).toBe(53);
  });

  it("changing the 32 metadata hash bytes still compares equal; changing one body byte fails with both hashes", () => {
    const { runtimeCode, abi } = val(readLegacyArtifact(outDir, "Token"));
    expect(abi.some((f) => f.type === "function")).toBe(true);
    const hashStart = runtimeCode.length - 2 * 43 + 2 * 9;
    const changedHash =
      runtimeCode.slice(0, hashStart) + "00".repeat(32) + runtimeCode.slice(hashStart + 64);
    expect(changedHash).not.toBe(runtimeCode);
    expect(compareRuntimeCode(runtimeCode, changedHash).ok).toBe(true);
    expect(val(hashRuntimeCode(changedHash))).toBe(val(hashRuntimeCode(runtimeCode)));

    const flipped = "0x" + (runtimeCode[2] === "6" ? "7" : "6") + runtimeCode.slice(3);
    const r = compareRuntimeCode(runtimeCode, flipped);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("BYTECODE_MISMATCH");
      const d = r.error.details as { compiled: { hash: string }; onChain: { hash: string } };
      expect(d.compiled.hash).toBe(val(hashRuntimeCode(runtimeCode)));
      expect(d.onChain.hash).toBe(val(hashRuntimeCode(flipped)));
    }
  });
});
