/**
 * Solc presence, runtime-code comparison and artifact reading for the Runner (task 10.3).
 *
 * - `checkSolcPresent`: `SOLC_MISSING` before any `forge build`. Never spawns forge; it only looks
 *   at the svm directory that forge uses for its solc binaries.
 * - `stripMetadataSuffix` / `hashRuntimeCode` / `compareRuntimeCode`: compare compiled and on-chain
 *   runtime code while ignoring the Metadata_Suffix (CBOR section whose length is in the last two
 *   bytes, big-endian, excluding those two bytes: suffix bytes = length + 2). Task 1.6 verified this
 *   for solc 0.4.19 (43 bytes, `0029`) and 0.8.28 (53 bytes, `0033`).
 * - `readLegacyArtifact`: ABI and runtime code of `out/Legacy<Name>.sol/<Name>.json`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadAbi } from "./abi.js";
import { keccak256 } from "./keccak.js";
import { err, ok, seanceError, type AbiFunction, type Result } from "./types.js";

// ---------------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------------

/** Lowercase, `0x`-less hex. Rejects empty, odd-length and non-hex input. */
function normaliseHex(code: string, what: string): Result<string> {
  if (typeof code !== "string") return err(seanceError("INVALID_INPUT", `${what} must be a hex string`));
  const body = code.replace(/^0[xX]/, "").toLowerCase();
  if (body.length === 0) return err(seanceError("INVALID_INPUT", `${what} is empty`));
  if (body.length % 2 !== 0) return err(seanceError("INVALID_INPUT", `${what} has an odd number of hex digits`));
  if (!/^[0-9a-f]+$/.test(body)) return err(seanceError("INVALID_INPUT", `${what} contains non-hex characters`));
  return ok(body);
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------------------
// Metadata suffix
// ---------------------------------------------------------------------------

/** First byte of the CBOR section: map with 1 to 5 entries (0xa1..0xa5). */
const CBOR_MAP_FIRST = 0xa1;
const CBOR_MAP_LAST = 0xa5;

/**
 * Removes the Metadata_Suffix. The last two bytes are a big-endian length L; the suffix is L + 2
 * bytes. It is stripped only when it fits in the code, leaves a non-empty body, and starts with a
 * CBOR map byte (0xa1..0xa5). Otherwise the code is returned unchanged (no recognisable suffix).
 * Returns lowercase `0x` hex. Odd length, non-hex and empty input are `INVALID_INPUT`.
 */
export function stripMetadataSuffix(code: string): Result<string> {
  const n = normaliseHex(code, "runtime code");
  if (!n.ok) return n;
  return ok("0x" + stripNormalised(n.value));
}

function stripNormalised(hex: string): string {
  const bytes = hex.length / 2;
  if (bytes < 3) return hex;
  const len = parseInt(hex.slice(hex.length - 4), 16);
  const suffixBytes = len + 2;
  if (suffixBytes >= bytes) return hex;
  const first = parseInt(hex.slice(hex.length - 2 * suffixBytes, hex.length - 2 * suffixBytes + 2), 16);
  if (first < CBOR_MAP_FIRST || first > CBOR_MAP_LAST) return hex;
  return hex.slice(0, hex.length - 2 * suffixBytes);
}

/** `0x`-prefixed keccak-256 of the code with its Metadata_Suffix stripped. */
export function hashRuntimeCode(code: string): Result<string> {
  const s = stripMetadataSuffix(code);
  if (!s.ok) return s;
  return ok("0x" + toHex(keccak256(hexToBytes(s.value.slice(2)))));
}

export interface CodeSummary {
  hash: string;
  /** Length in bytes of the stripped code. */
  length: number;
}

/**
 * Compares compiled and on-chain runtime code with the Metadata_Suffix stripped from both sides.
 * `BYTECODE_MISMATCH` carries both stripped-code hashes and lengths, in the message and in
 * `details: { compiled: CodeSummary; onChain: CodeSummary }`.
 */
export function compareRuntimeCode(compiled: string, onChain: string): Result<void> {
  const a = stripMetadataSuffix(compiled);
  if (!a.ok) return err(seanceError("INVALID_INPUT", `compiled code: ${a.error.message}`));
  const b = stripMetadataSuffix(onChain);
  if (!b.ok) return err(seanceError("INVALID_INPUT", `on-chain code: ${b.error.message}`));
  if (a.value === b.value) return ok(undefined);
  // Hash the already-stripped bytes directly: stripping twice could strip a second suffix.
  const summary = (stripped: string): CodeSummary => ({
    hash: "0x" + toHex(keccak256(hexToBytes(stripped.slice(2)))),
    length: (stripped.length - 2) / 2,
  });
  const compiled_ = summary(a.value);
  const onChain_ = summary(b.value);
  return err(
    seanceError(
      "BYTECODE_MISMATCH",
      `runtime code mismatch: compiled legacy code hash ${compiled_.hash} (${compiled_.length} bytes) differs from on-chain code hash ${onChain_.hash} (${onChain_.length} bytes), metadata suffix ignored`,
      { compiled: compiled_, onChain: onChain_ },
    ),
  );
}

// ---------------------------------------------------------------------------
// Solc presence
// ---------------------------------------------------------------------------

/**
 * Directories that may hold svm installs (`<root>/<version>/solc-<version>`):
 * `SVM_HOME` if set, `~/.svm`, and the platform data dir (`~/Library/Application Support/svm` on
 * macOS, `$XDG_DATA_HOME/svm` or `~/.local/share/svm` elsewhere). In the Docker image
 * (`HOME=/root`) this is `/root/.svm` or `/root/.local/share/svm`.
 */
export function svmRoots(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const roots: string[] = [];
  if (env["SVM_HOME"]) roots.push(env["SVM_HOME"]);
  roots.push(join(home, ".svm"));
  if (process.platform === "darwin") roots.push(join(home, "Library", "Application Support", "svm"));
  else roots.push(join(env["XDG_DATA_HOME"] || join(home, ".local", "share"), "svm"));
  return roots;
}

/** Versions with an installed `solc-<version>` binary in any svm root. Sorted, unique. */
export function listInstalledSolc(roots: string[] = svmRoots()): string[] {
  const found = new Set<string>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const v of entries) {
      if (/^\d+\.\d+\.\d+$/.test(v) && existsSync(join(root, v, `solc-${v}`))) found.add(v);
    }
  }
  return [...found].sort();
}

/**
 * `SOLC_MISSING` naming the version when it is not installed. `installed` is a plain list or an
 * async provider (tests inject a list). Does not spawn forge and builds nothing.
 */
export async function checkSolcPresent(
  version: string,
  installed: string[] | (() => string[] | Promise<string[]>) = () => listInstalledSolc(),
): Promise<Result<void>> {
  const list = typeof installed === "function" ? await installed() : installed;
  if (list.includes(version)) return ok(undefined);
  return err(
    seanceError("SOLC_MISSING", `solc ${version} is not installed; forge build was not run`, {
      version,
      installed: [...list].sort(),
    }),
  );
}

// ---------------------------------------------------------------------------
// Artifact reading
// ---------------------------------------------------------------------------

export interface LegacyArtifact {
  abi: AbiFunction[];
  /** Lowercase `0x` runtime code (`deployedBytecode.object`), not stripped. */
  runtimeCode: string;
}

export function readArtifactJson(path: string, kind: string): Result<Record<string, unknown>> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return err(
      seanceError("BUILD_FAILED", `${kind} artifact not found or unreadable: ${path} (${(e as Error).message})`, { path }),
    );
  }
  try {
    const j: unknown = JSON.parse(text);
    if (typeof j !== "object" || j === null || Array.isArray(j)) throw new Error("not a JSON object");
    return ok(j as Record<string, unknown>);
  } catch (e) {
    return err(seanceError("BUILD_FAILED", `${kind} artifact is not valid JSON: ${path} (${(e as Error).message})`, { path }));
  }
}

/** Reads `out/Legacy<name>.sol/<name>.json`: the ABI and the runtime code of the legacy build. */
export function readLegacyArtifact(outDir: string, name: string): Result<LegacyArtifact> {
  const path = join(outDir, `Legacy${name}.sol`, `${name}.json`);
  const j = readArtifactJson(path, "legacy");
  if (!j.ok) return j;

  const deployed = j.value["deployedBytecode"];
  const object =
    typeof deployed === "object" && deployed !== null ? (deployed as Record<string, unknown>)["object"] : undefined;
  if (typeof object !== "string" || object === "") {
    return err(seanceError("BUILD_FAILED", `legacy artifact has no deployedBytecode.object: ${path}`, { path }));
  }
  if (object.includes("_")) {
    // Link placeholders (`__$...$__`, or `__Lib___` in old solc); valid hex never contains `_`.
    return err(
      seanceError("INVALID_INPUT", `legacy artifact ${path} contains unlinked library placeholders; linked libraries are not supported`, { path }),
    );
  }
  if (!/^0x/.test(object)) {
    return err(seanceError("BUILD_FAILED", `legacy deployedBytecode.object is not 0x-prefixed hex: ${path}`, { path }));
  }
  const code = normaliseHex(object, "legacy deployedBytecode.object");
  if (!code.ok) return err(seanceError("BUILD_FAILED", `${code.error.message}: ${path}`, { path }));

  const abi = loadAbi(j.value["abi"]);
  if (!abi.ok) return err(seanceError("BUILD_FAILED", `legacy artifact ${path}: ${abi.error.message}`, { path }));
  return ok({ abi: abi.value, runtimeCode: "0x" + code.value });
}
