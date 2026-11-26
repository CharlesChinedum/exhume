/**
 * Port ABI compatibility check (task 10.3, design decision 18).
 *
 * Compares function entries only, by name plus the ordered canonical input types, as a multiset.
 * `stateMutability`, outputs, events, errors, constructor, fallback and receive are ignored.
 */
import { join } from "node:path";
import { loadAbi } from "./abi.js";
import { readArtifactJson } from "./bytecode.js";
import { err, ok, seanceError, type AbiFunction, type AbiParam, type Result } from "./types.js";

/** Canonical type of one parameter: tuples expand to `(t1,t2)`, array suffixes are kept. */
export function canonicalType(p: AbiParam): string {
  const m = /^tuple((?:\[\d*\])*)$/.exec(p.type);
  if (m) return `(${(p.components ?? []).map(canonicalType).join(",")})${m[1] ?? ""}`;
  // `uint`/`int` are aliases of `uint256`/`int256`; solc's own ABI already writes the long form.
  return p.type.replace(/^(u?int)(?=(\[|$))/, "$1256");
}

/** `name(type1,type2,...)` for a function entry. */
export function functionKey(f: AbiFunction): string {
  return `${f.name ?? ""}(${f.inputs.map(canonicalType).join(",")})`;
}

function multiset(abi: AbiFunction[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of abi) {
    if (f.type !== "function") continue;
    const k = functionKey(f);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function surplus(a: Map<string, number>, b: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [k, n] of a) for (let i = 0; i < n - (b.get(k) ?? 0); i++) out.push(k);
  return out.sort();
}

/**
 * `INVALID_INPUT` with `details: { onlyInLegacy, onlyInPort }` (sorted; a signature present twice
 * in one ABI and once in the other appears once) when the function sets differ.
 */
export function compareAbis(legacy: AbiFunction[], port: AbiFunction[]): Result<void> {
  const l = multiset(legacy);
  const p = multiset(port);
  const onlyInLegacy = surplus(l, p);
  const onlyInPort = surplus(p, l);
  if (onlyInLegacy.length === 0 && onlyInPort.length === 0) return ok(undefined);
  const parts: string[] = [];
  if (onlyInLegacy.length > 0) parts.push(`missing in port: ${onlyInLegacy.join(", ")}`);
  if (onlyInPort.length > 0) parts.push(`extra in port: ${onlyInPort.join(", ")}`);
  return err(
    seanceError("INVALID_INPUT", `port ABI differs from legacy ABI: ${parts.join("; ")}`, { onlyInLegacy, onlyInPort }),
  );
}

/** Reads the port ABI from `out/Port<name>.sol/<name>.json`. */
export function readPortArtifact(outDir: string, name: string): Result<AbiFunction[]> {
  const path = join(outDir, `Port${name}.sol`, `${name}.json`);
  const j = readArtifactJson(path, "port");
  if (!j.ok) return j;
  const abi = loadAbi(j.value["abi"]);
  if (!abi.ok) return err(seanceError("BUILD_FAILED", `port artifact ${path}: ${abi.error.message}`, { path }));
  return ok(abi.value);
}
