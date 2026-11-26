/**
 * Input_Generator: targeted values for every Arithmetic_Site (Requirement 6).
 *
 * Pure and deterministic: no randomness, no clocks, stable ordering. All
 * arithmetic is `bigint`. Values stay `bigint` in the plan; convert to decimal
 * strings only when writing JSON.
 *
 * Decisions where the design was silent are listed in the task report and
 * marked `Decision:` below.
 */
import {
  err,
  ok,
  seanceError,
  type AbiFunction,
  type AbiParam,
  type ArithmeticSite,
  type AutopsyReport,
  type Operand,
  type ParamSlot,
  type Result,
  type SeedCall,
  type SiteTargets,
  type TargetEntry,
  type TargetPlan,
} from "./types.js";

/** Requirement 6.1: at most 64 entries per site. */
export const MAX_ENTRIES_PER_SITE = 64;
/** Requirement 6.10: at most 10 calls per seed sequence. */
export const MAX_SEED_CALLS = 10;
/** Requirement 6.8: array lengths 2..24. */
export const MIN_ARRAY_LEN = 2n;
export const MAX_ARRAY_LEN = 24n;

const UINT256_MAX = (1n << 256n) - 1n;
/** Actors A1..A3 (the design's ACTORS = [DEPLOYER, A1, A2, A3]); index 0 is the deployer. */
const SEED_SPENDERS = [1, 2, 3] as const;

// ---------------------------------------------------------------------------
// ABI layout
// ---------------------------------------------------------------------------

const FIXED_ARRAY = /^(.*)\[(\d+)\]$/;

function isDynamicType(p: AbiParam): boolean {
  if (p.type === "bytes" || p.type === "string" || p.type.endsWith("[]")) return true;
  const fixed = FIXED_ARRAY.exec(p.type);
  if (fixed) return isDynamicType({ ...p, type: fixed[1] as string });
  if (p.type === "tuple") return (p.components ?? []).some(isDynamicType);
  return false;
}

/** Number of 32-byte head words the parameter occupies. */
function headWords(p: AbiParam): number {
  if (isDynamicType(p)) return 1;
  const fixed = FIXED_ARRAY.exec(p.type);
  if (fixed) return Number(fixed[2]) * headWords({ ...p, type: fixed[1] as string });
  if (p.type === "tuple") return (p.components ?? []).reduce((s, c) => s + headWords(c), 0);
  return 1;
}

function headOffsetOf(inputs: AbiParam[], index: number): number {
  let words = 0;
  for (let i = 0; i < index; i++) words += headWords(inputs[i] as AbiParam);
  return 4 + 32 * words;
}

const STATIC_TARGETABLE = /^(u?int\d*|bool|bytes\d+)$/;

/** Resolves an operand to the calldata slot the handler can set, or undefined. */
function resolveSlot(op: Operand, fn: AbiFunction): ParamSlot | undefined {
  if (op.kind !== "param" && op.kind !== "arrayLength") return undefined;
  const index = fn.inputs.findIndex((p) => p.name === op.name);
  if (index < 0) return undefined;
  const p = fn.inputs[index] as AbiParam;
  const headOffset = headOffsetOf(fn.inputs, index);
  if (op.kind === "arrayLength") {
    // `bytes`/`string` lengths are not targeted (design table: no slot kind).
    return p.type.endsWith("[]") ? { encoding: "dynamicArrayLength", paramIndex: index, headOffset } : undefined;
  }
  return STATIC_TARGETABLE.test(p.type) ? { encoding: "static", paramIndex: index, headOffset } : undefined;
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

function typeWidth(type: string): number | undefined {
  const m = /^u?int(\d+)?$/.exec(type);
  if (!m) return undefined;
  return m[1] === undefined ? 256 : Number(m[1]);
}

/** N: width of the narrowest operand type; 256 when no operand type is an integer type (Req 6.6). */
function narrowestWidth(ops: readonly Operand[]): number {
  let n = 256;
  for (const op of ops) {
    const w = typeWidth(op.type);
    if (w !== undefined && w < n) n = w;
  }
  return n;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** Integers in [lo, hi] with both bounds clamped to [0, M-1], ascending. */
function window(lo: bigint, hi: bigint, M: bigint): bigint[] {
  const clamp = (v: bigint) => (v < 0n ? 0n : v > M - 1n ? M - 1n : v);
  const out: bigint[] = [];
  for (let v = clamp(lo); v <= clamp(hi); v++) out.push(v);
  return out;
}

/** Smallest e >= 1 with b^e >= M (b >= 2). */
function minExponent(b: bigint, M: bigint): bigint {
  let e = 1n;
  let p = b;
  while (p < M) {
    p *= b;
    e++;
  }
  return e;
}

/** Smallest x >= 1 with x^e >= M (e >= 1). */
function minRoot(e: bigint, M: bigint): bigint {
  let lo = 1n;
  let hi = M;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (mid ** e >= M) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Entry construction
// ---------------------------------------------------------------------------

type Pick = readonly [ParamSlot | undefined, bigint];

function entryKey(e: TargetEntry): string {
  return e.assignments.map((a) => `${a.slot.encoding}:${a.slot.paramIndex}=${a.value.toString(10)}`).join("|");
}

/**
 * One entry from one or two picks. Picks without a slot are dropped. Two picks on
 * the same slot collapse to the first (Decision: x * x cannot assign two values).
 */
function entry(...picks: Pick[]): TargetEntry {
  const assignments: TargetEntry["assignments"] = [];
  for (const [slot, value] of picks) {
    if (slot === undefined) continue;
    if (assignments.some((a) => a.slot.paramIndex === slot.paramIndex)) continue;
    assignments.push({ slot, value });
  }
  return { assignments };
}

/** Removes duplicates keeping first occurrence, then applies the 64 cap (priority = list order). */
function finish(entries: TargetEntry[]): TargetEntry[] {
  const seen = new Set<string>();
  const out: TargetEntry[] = [];
  for (const e of entries) {
    const k = entryKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
    if (out.length === MAX_ENTRIES_PER_SITE) break;
  }
  // Requirement 6.1 floor: at least one entry. Only reachable if `entries` is empty.
  return out.length > 0 ? out : [{ assignments: [] }];
}

const singles = (slot: ParamSlot | undefined, values: bigint[]): TargetEntry[] =>
  values.map((v) => entry([slot, v]));

/** Decision: when no operand is known and no rule fits, probe the type's boundaries. */
const boundaryValues = (M: bigint): bigint[] => [M - 1n, M / 2n, 2n].filter((v) => v < M);

/** Pairs (2^i, 2^(N-i)) ordered: center, 1, N-1, then by distance from the center (ties: lower i). */
function productExponents(N: number): number[] {
  const center = N / 2;
  const first = [center, 1, N - 1];
  const rest: number[] = [];
  for (let i = 1; i <= N - 1; i++) if (!first.includes(i)) rest.push(i);
  rest.sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
  return [...first, ...rest].filter((i, idx, all) => i >= 1 && i <= N - 1 && all.indexOf(i) === idx);
}

function powPairs(N: number, M: bigint): [bigint, bigint][] {
  const half = 1n << BigInt(N / 2);
  const bases = [2n, 3n, 4n, 5n, 7n, 10n, 16n, 256n, half, 1n << BigInt(N - 1), M - 1n];
  const out: [bigint, bigint][] = [];
  const seen = new Set<string>();
  const push = (b: bigint, e: bigint) => {
    const k = `${b},${e}`;
    if (b < 2n || b >= M || e >= M || seen.has(k)) return;
    seen.add(k);
    out.push([b, e]);
  };
  // Required first: (2, N), (2, N+1), (3, minimal exponent).
  push(2n, BigInt(N));
  push(2n, BigInt(N) + 1n);
  push(3n, minExponent(3n, M));
  for (const b of bases) {
    if (b < 2n || b >= M) continue;
    const e0 = minExponent(b, M);
    push(b, e0);
    push(b, e0 + 1n);
  }
  return out;
}

function targetsFor(site: ArithmeticSite, fn: AbiFunction): TargetEntry[] {
  const [a, b] = site.operands;
  const N = narrowestWidth(site.operands);
  const M = 1n << BigInt(N);
  const sa = resolveSlot(a, fn);
  const sb = resolveSlot(b, fn);
  const knownOf = (o: Operand) => (o.kind === "known" ? BigInt(o.value) : undefined);
  const ka = knownOf(a);
  const kb = knownOf(b);

  if (ka !== undefined && kb !== undefined) return finish([]); // constant expression, nothing to target

  switch (site.operator) {
    case "*": {
      // Array length times value (Req 6.8): one entry sets both.
      const aLen = a.kind === "arrayLength";
      const bLen = b.kind === "arrayLength";
      if (aLen !== bLen && ka === undefined && kb === undefined) {
        const lenSlot = aLen ? sa : sb;
        const valSlot = aLen ? sb : sa;
        const out: TargetEntry[] = [];
        for (let n = MIN_ARRAY_LEN; n <= MAX_ARRAY_LEN; n++) out.push(entry([lenSlot, n], [valSlot, ceilDiv(M, n)]));
        return finish(out);
      }
      // x * k (Req 6.2): window around ceil(M/k).
      const k = ka ?? kb;
      if (k !== undefined) {
        const slot = ka !== undefined ? sb : sa;
        if (k > 1n) {
          const c = ceilDiv(M, k);
          return finish(singles(slot, window(c - 2n, c + 2n, M)));
        }
        return finish(singles(slot, boundaryValues(M)));
      }
      // x * y (Req 6.5): pairs (2^i, 2^(N-i)).
      if (sa !== undefined && sb !== undefined && sa.paramIndex === sb.paramIndex) {
        const h = 1n << BigInt(N / 2);
        return finish(singles(sa, [h, h + 1n, M / 2n, M - 1n]));
      }
      return finish(productExponents(N).map((i) => entry([sa, 1n << BigInt(i)], [sb, 1n << BigInt(N - i)])));
    }
    case "+": {
      // a + b (Req 6.3): either side may be the known one.
      if (ka !== undefined) return finish(singles(sb, window(M - 1n - ka - 2n, M - 1n - ka + 2n, M)));
      if (kb !== undefined) return finish(singles(sa, window(M - 1n - kb - 2n, M - 1n - kb + 2n, M)));
      const h = M / 2n;
      return finish(
        [
          [M - 1n, M - 1n],
          [M - 1n, 1n],
          [1n, M - 1n],
          [h, h],
        ].map(([x, y]) => entry([sa, x as bigint], [sb, y as bigint])),
      );
    }
    case "-": {
      // a - b (Req 6.4). Decision: for `x - k` the window is around k on x.
      if (ka !== undefined) return finish(singles(sb, window(ka - 2n, ka + 2n, M)));
      if (kb !== undefined) return finish(singles(sa, window(kb - 2n, kb + 2n, M)));
      const h = M / 2n;
      return finish(
        [
          [0n, 1n],
          [0n, M - 1n],
          [1n, 2n],
          [h, h + 1n],
        ].map(([x, y]) => entry([sa, x as bigint], [sb, y as bigint])),
      );
    }
    case "**": {
      // Decision: known base: exponents around the minimal overflowing one; known exponent: bases around the minimal root.
      if (ka !== undefined) {
        if (ka < 2n || ka >= M) return finish(singles(sb, boundaryValues(M)));
        const e0 = minExponent(ka, M);
        return finish(singles(sb, window(e0 - 1n, e0 + 2n, M)));
      }
      if (kb !== undefined) {
        if (kb < 2n) return finish(singles(sa, boundaryValues(M)));
        const r = minRoot(kb, M);
        return finish(singles(sa, window(r - 2n, r + 2n, M)));
      }
      return finish(powPairs(N, M).map(([base, exp]) => entry([sa, base], [sb, exp])));
    }
  }
}

// ---------------------------------------------------------------------------
// Seed sequences (Req 6.10, 6.12)
// ---------------------------------------------------------------------------

function hasFn(abi: AbiFunction[], name: string): boolean {
  return abi.some(
    (f) =>
      f.type === "function" &&
      f.name === name &&
      f.inputs.length === 2 &&
      f.inputs[0]?.type === "address" &&
      f.inputs[1]?.type === "uint256",
  );
}

/**
 * Decision: precondition kinds map to calls as follows. `hint` is free text and is not parsed.
 * - constructor-balance: always satisfiable, needs no call (the constructor and the token-share
 *   setup step provide the balance).
 * - approve: the deployer (actor 0) approves actors 1..3 for 2^256-1. Needs `approve(address,uint256)`.
 * - transfer: the deployer transfers 1 unit to actors 1..3. Needs `transfer(address,uint256)`.
 * Address arguments are Actor_Set indices written as decimal strings (the handler's `actorIdx`).
 * A kind whose function is missing from the ABI makes the site unreachable.
 */
function seedFor(site: ArithmeticSite, abi: AbiFunction[]): { calls: SeedCall[]; unreachable: boolean } {
  const calls: SeedCall[] = [];
  let unreachable = false;
  for (const pre of site.precondition ?? []) {
    if (pre.kind === "constructor-balance") continue;
    const fn = pre.kind; // "approve" | "transfer"
    if (!hasFn(abi, fn)) {
      unreachable = true;
      continue;
    }
    const amount = fn === "approve" ? UINT256_MAX.toString(10) : "1";
    for (const spender of SEED_SPENDERS) calls.push({ function: fn, args: [String(spender), amount], actorIdx: 0 });
  }
  return { calls: calls.slice(0, MAX_SEED_CALLS), unreachable };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Signature (design): `generateTargets(report, abi)`. Decision: it returns `Result<TargetPlan>`
 * (as the task asks) so a site naming a function absent from the ABI is an `AUTOPSY_REJECTED`
 * error instead of a throw. Task 4.2 already rejects that earlier; this is a safety net for
 * direct callers.
 *
 * Seed sequences: one per site that needs calls, in site order, identical sequences kept once.
 */
export function generateTargets(report: AutopsyReport, abi: AbiFunction[]): Result<TargetPlan> {
  const sites: SiteTargets[] = [];
  const seedSequences: SeedCall[][] = [];
  const seenSeeds = new Set<string>();

  const missing = report.sites
    .filter((s) => !abi.some((f) => f.type === "function" && f.name === s.function))
    .map((s) => s.function);
  if (missing.length > 0) {
    const unknownFunctions = [...new Set(missing)];
    return err(
      seanceError(
        "AUTOPSY_REJECTED",
        `Autopsy report names functions that are not in the ABI: ${unknownFunctions.join(", ")}`,
        { reason: "unknown-functions", unknownFunctions },
      ),
    );
  }

  for (const site of report.sites) {
    const candidates = abi.filter((f) => f.type === "function" && f.name === site.function);
    // Decision: with overloads, take the first one that has every named operand as a parameter, else the first.
    const names = site.operands.flatMap((o) => (o.kind === "param" || o.kind === "arrayLength" ? [o.name] : []));
    const fn =
      candidates.find((f) => names.every((n) => f.inputs.some((p) => p.name === n))) ?? (candidates[0] as AbiFunction);

    const seed = seedFor(site, abi);
    if (seed.calls.length > 0) {
      const key = JSON.stringify(seed.calls);
      if (!seenSeeds.has(key)) {
        seenSeeds.add(key);
        seedSequences.push(seed.calls);
      }
    }
    const entries = targetsFor(site, fn);
    // Unreachable when no seed is resolvable, or when no operand mapped to a handler parameter
    // (every entry has empty assignments; the entry list then is the single empty entry).
    const allEmpty = entries.every((e) => e.assignments.length === 0);
    sites.push({
      siteId: site.id,
      functionName: site.function,
      entries,
      unreachable: seed.unreachable || allEmpty,
    });
  }
  return ok({ sites, seedSequences });
}
