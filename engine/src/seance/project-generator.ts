/**
 * Project_Generator (task 8.5): turns a validated séance input, a TargetPlan and the legacy ABI into the
 * files of a Foundry project, and writes them to disk.
 *
 * - `generateProject` is pure: no clock, randomness, environment or filesystem reads except the packaged
 *   templates in `./templates` (constant text). Identical inputs give byte-identical files; the file list is
 *   sorted by path (UTF-16 code unit order); every generated file uses LF newlines. The two contract
 *   sources are copied unchanged. There is no `lib/`.
 * - `writeProject` / `writeProjectFiles` validate the file list first and write nothing when it is invalid.
 * - `regenerateWitness` and `regenerateReplay` rewrite exactly one file each (`test/Witness.t.sol`,
 *   `test/Replay.t.sol`) for the Runner's later phases.
 *
 * - The generator is two-staged so the Runner can build before it knows the ABI: `generateSrcProject`
 *   (`src/`, `foundry.toml`, `remappings.txt`) and `generateTestProject` (everything under `test/`);
 *   `generateProject` is their composition. `writeProjectFiles` writes the first stage into a fresh
 *   directory (`mode: "fresh"`) and the second into the same directory later (`mode: "add"`).
 *
 * KNOWN LIMITATION (stack depth, design decision 19). Handler functions are compiled without `via_ir`, so a
 * function with many or large parameters makes solc fail with "Stack too deep". The generator estimates each
 * handler's stack use (`estimateHandlerStack`) and SKIPS any function whose estimate exceeds
 * `MAX_HANDLER_STACK`: no handler is generated, it is absent from the selector lists, its arithmetic sites are
 * unreachable and seed calls naming it are dropped, so the Séance cannot reach it. It stays a known selector
 * (`Targets.isKnownSelector`) so the fallback handler never aims at it. Skipped functions are returned as
 * `skippedFunctions` and end up in the report. Calibration: engine/test/docker/findings/8.5.stack-limit.native.md.
 *
 * The Solidity templates are read with `readFileSync` relative to this module (`templatesDir()`), so the
 * `templates/` directory must ship next to this file (worker image).
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FORGE_STD_DEFAULT_DIR, PORT_SOLC_VERSION, remappingsText } from "./forge-std-pin.js";
import { renderFoundryToml } from "./foundry-config.js";
import { validateInput } from "./inputs.js";
import { selectorOf } from "./keccak.js";
import {
  err,
  ok,
  seanceError,
  type AbiFunction,
  type AbiParam,
  type FindingClassification,
  type Result,
  type SeanceInput,
  type SeedCall,
  type TargetEntry,
  type TargetPlan,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WitnessPair {
  /** Handler function name as written in the records' `function` field (an ABI name or "fallback"). */
  function: string;
  classification: FindingClassification;
}

export interface GeneratorOptions {
  /** `<FORGE_STD_DIR>`: absolute path, no trailing slash, default `/opt/forge-std`. */
  forgeStdDir?: string;
  /** Port restriction also carries `min_optimizer_runs = max_optimizer_runs = R` (optimizer enabled only). */
  portSharesLegacyOptimizer?: boolean;
  /**
   * Wei both deployments are funded with after construction (`Targets.FUNDING_WEI`). Not part of
   * `SeanceInput`, so it is a generator option; default 0.
   */
  fundingWei?: bigint | number | string;
  /** (function, class) pairs written into `Witness.t.sol` (k = index + 1, at most 10). Default: none. */
  witnessPairs?: WitnessPair[];
  /**
   * Calibration and test override of the skip threshold (default `MAX_HANDLER_STACK`). `regenerateWitness` and
   * `regenerateReplay` always use `MAX_HANDLER_STACK`, so do not set this in production.
   */
  maxHandlerStack?: number;
}

export interface ProjectFile {
  path: string;
  contents: string;
}
/** Sorted by `path`, unique paths, no `lib/`. */
export type ProjectFiles = ProjectFile[];

/** One call of `counterexample.Sequence[1]` from `forge test --json`. */
export interface ShrunkCall {
  func_name: string;
  calldata: string;
  sender?: string;
}
export interface ShrunkSequence {
  /** Witness index, 1..10, selects the `SeanceReplay<k>` contract. */
  k: number;
  calls: ShrunkCall[];
}

export const MAX_WITNESS_PAIRS = 10;
export const PATHS = {
  foundryToml: "foundry.toml",
  remappings: "remappings.txt",
  handler: "test/handler/DifferentialHandler.sol",
  classifier: "test/handler/Classifier.sol",
  targets: "test/handler/Targets.sol",
  seance: "test/Seance.t.sol",
  witness: "test/Witness.t.sol",
  replay: "test/Replay.t.sol",
} as const;
export const legacyPath = (name: string): string => `src/legacy/Legacy${name}.sol`;
export const portPath = (name: string): string => `src/port/Port${name}.sol`;

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** Directory holding the Solidity templates; must ship with the package. */
export function templatesDir(): string {
  return fileURLToPath(new URL("./templates/", import.meta.url));
}

const TEMPLATE_NAMES = ["Handler.sol", "Classifier.sol", "Seance.t.sol", "Witness.t.sol", "Replay.t.sol"] as const;
type TemplateName = (typeof TEMPLATE_NAMES)[number];
const templateCache = new Map<TemplateName, string>();

function loadTemplate(name: TemplateName): string {
  const hit = templateCache.get(name);
  if (hit !== undefined) return hit;
  const text = readFileSync(`${templatesDir()}${name}`, "utf8").replace(/\r\n?/g, "\n");
  templateCache.set(name, text);
  return text;
}

/** Replaces the whole marker line `<indent>// @@NAME@@` (any indentation) with `body`. Exactly one match required. */
function fillMarker(template: string, marker: string, body: string): string {
  const re = new RegExp(`^[ \\t]*// @@${marker}@@[ \\t]*$`, "gm");
  const n = template.match(re)?.length ?? 0;
  if (n !== 1) throw new Error(`template marker @@${marker}@@ found ${n} times, expected 1`);
  return template.replace(re, () => body.replace(/\n$/, ""));
}

function failed(message: string, details?: unknown): Result<never> {
  return err(seanceError("SEANCE_FAILED", message, details));
}
function invalid(message: string, details?: unknown): Result<never> {
  return err(seanceError("INVALID_INPUT", message, details));
}

// ---------------------------------------------------------------------------
// ABI type handling
// ---------------------------------------------------------------------------

type Scalar =
  | { k: "uint" | "int"; bits: number }
  | { k: "bool" }
  | { k: "bytesN"; n: number }
  | { k: "address" };

type ParamKind =
  | { kind: "scalar"; t: Exclude<Scalar, { k: "address" }> }
  | { kind: "address" }
  | { kind: "addressArray" }
  | { kind: "array"; elem: Exclude<Scalar, { k: "address" }> }
  | { kind: "bytes" }
  | { kind: "string" };

function parseScalar(t: string): Scalar | undefined {
  let m = /^(uint|int)(\d+)?$/.exec(t);
  if (m) {
    const bits = m[2] === undefined ? 256 : Number(m[2]);
    return bits >= 8 && bits <= 256 && bits % 8 === 0 ? { k: m[1] as "uint" | "int", bits } : undefined;
  }
  if (t === "bool") return { k: "bool" };
  if (t === "address") return { k: "address" };
  m = /^bytes(\d+)$/.exec(t);
  if (m) {
    const n = Number(m[1]);
    return n >= 1 && n <= 32 ? { k: "bytesN", n } : undefined;
  }
  return undefined;
}

/** Parameter mapping table of the design; `undefined` for types outside it. */
function parseParamType(type: string): ParamKind | undefined {
  if (type === "bytes") return { kind: "bytes" };
  if (type === "string") return { kind: "string" };
  if (type.endsWith("[]")) {
    const e = parseScalar(type.slice(0, -2));
    if (e === undefined) return undefined;
    return e.k === "address" ? { kind: "addressArray" } : { kind: "array", elem: e };
  }
  const s = parseScalar(type);
  if (s === undefined) return undefined;
  return s.k === "address" ? { kind: "address" } : { kind: "scalar", t: s };
}

const scalarTypeName = (t: Scalar): string =>
  t.k === "bool" ? "bool" : t.k === "address" ? "address" : t.k === "bytesN" ? `bytes${t.n}` : `${t.k}${t.bits}`;

/** Solidity expression converting the `uint256` expression `src` into the scalar type `t`. */
function castExpr(t: Scalar, src: string): string {
  switch (t.k) {
    case "uint":
      return t.bits === 256 ? src : `uint${t.bits}(${src})`;
    case "int":
      return t.bits === 256 ? `int256(${src})` : `int${t.bits}(uint${t.bits}(${src}))`;
    case "bool":
      return `(${src} & 1) == 1`;
    case "bytesN":
      return t.n === 32 ? `bytes32(${src})` : `bytes${t.n}(bytes32(${src}))`;
    case "address":
      return `_addr(uint8(${src}))`;
  }
}

const SAFE_TYPE = /^[A-Za-z0-9_$[\](),]+$/;

/** Canonical ABI type, tuples expanded; `undefined` when the type text is not safe to embed in Solidity. */
function canonicalType(p: AbiParam): string | undefined {
  let t = p.type;
  if (typeof t !== "string") return undefined;
  if (t.startsWith("tuple")) {
    const parts: string[] = [];
    for (const c of p.components ?? []) {
      const ct = canonicalType(c);
      if (ct === undefined) return undefined;
      parts.push(ct);
    }
    t = `(${parts.join(",")})${t.slice("tuple".length)}`;
  } else {
    t = t.replace(/^uint(?=$|\[)/, "uint256").replace(/^int(?=$|\[)/, "int256");
  }
  return SAFE_TYPE.test(t) ? t : undefined;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function signatureOf(f: AbiFunction): Result<string> {
  const types: string[] = [];
  for (const p of f.inputs) {
    const t = canonicalType(p);
    if (t === undefined) return invalid(`function ${f.name}: parameter type ${JSON.stringify(p.type)} is not a valid ABI type`);
    types.push(t);
  }
  return ok(`${f.name}(${types.join(",")})`);
}

// ---------------------------------------------------------------------------
// Stack-depth estimate (design decision 19)
// ---------------------------------------------------------------------------

/**
 * Stack-slot costs of the estimate, calibrated by compiling the real handler without `via_ir` (see
 * engine/test/docker/findings/8.5.stack-limit.native.md).
 *
 *   estimate = fixed + (payable ? payable : 0) + sum over the ABI parameters of the cost of its kind
 *
 *   scalar (uintN, intN, bool, bytesN) and address : 1  (one external parameter, `address` is a `uint8` index)
 *   address[] and other dynamic arrays             : 3  (external length and seed/pack parameters, plus the
 *                                                       memory array local)
 *   bytes and string                               : 2  (calldata offset and length)
 *   payable                                        : 1  (`weiValue`)
 *   fixed                                          : 7  (return label, `pick`, `actorIdx`, `p`, `cd`, the
 *                                                       encoder's temporaries)
 *
 * With `MAX_HANDLER_STACK = 16`, the number of slots solc can reach, the homogeneous experiments give exactly
 * 9 scalars, 3 dynamic arrays and 4 `bytes`/`string` parameters as the largest signatures that build. Every
 * cost is positive, so adding a parameter never decreases the estimate.
 */
export const STACK_COST = {
  fixed: 7,
  payable: 1,
  scalar: 1,
  address: 1,
  array: 3,
  bytes: 2,
} as const;

/** Handler functions whose estimate is above this are skipped (set from the compile experiment). */
export const MAX_HANDLER_STACK = 16;

export interface SkippedFunction {
  name: string;
  reason: "stack";
}

/**
 * Estimated stack slots the handler function for `fn` needs, from its parameter mapping. Pure and monotone:
 * a parameter of an unsupported type is charged like the largest kind (the generator rejects it anyway).
 */
export function estimateHandlerStack(fn: AbiFunction): number {
  let n = STACK_COST.fixed + (fn.stateMutability === "payable" ? STACK_COST.payable : 0);
  for (const p of fn.inputs) {
    const k = parseParamType(canonicalType(p) ?? "");
    switch (k?.kind) {
      case "scalar":
        n += STACK_COST.scalar;
        break;
      case "address":
        n += STACK_COST.address;
        break;
      case "addressArray":
      case "array":
        n += STACK_COST.array;
        break;
      default: // bytes, string, unsupported
        n += STACK_COST.bytes;
    }
  }
  return n;
}

const isHandlerAbiFn = (f: AbiFunction): boolean =>
  f.type === "function" && typeof f.name === "string" && (f.stateMutability === "nonpayable" || f.stateMutability === "payable");

/**
 * The state-changing functions whose estimate is above `max` (default `MAX_HANDLER_STACK`), sorted by name
 * (UTF-16 code unit order) with each name once.
 */
export function computeSkippedFunctions(abi: AbiFunction[], max: number = MAX_HANDLER_STACK): SkippedFunction[] {
  const names = new Set<string>();
  for (const f of abi) if (isHandlerAbiFn(f) && estimateHandlerStack(f) > max) names.add(f.name as string);
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((name) => ({ name, reason: "stack" as const }));
}

// ---------------------------------------------------------------------------
// Identifier allocation
// ---------------------------------------------------------------------------

const SOLIDITY_WORDS = new Set(
  (
    "abstract after alias anonymous apply assembly auto break byte calldata case catch constant constructor continue " +
    "contract copyof days default define delete do else emit enum error ether event external fallback false final " +
    "finney fixed for from function gwei hex hours if immutable implements import in indexed inline interface " +
    "internal is let library macro mapping match memory minutes modifier mutable new null of override partial " +
    "payable pragma private promise public pure receive reference relocatable return returns revert sealed " +
    "seconds sizeof static storage string struct super supports switch szabo this throw true try type typedef " +
    "typeof ufixed unchecked unicode using var view virtual weeks wei while years address bool abi block msg tx " +
    "now assert require keccak256 sha256 ripemd160 ecrecover addmod mulmod gasleft blockhash selfdestruct"
  ).split(" "),
);
/** Names used by the handler function bodies and by the handler / Test contracts' members. */
const HANDLER_NAMES = new Set(
  (
    "p cd j pick actorIdx weiValue data value vm init idx legacy port stopped diverged inSetup initialised record " +
    "outputPath witnessFn witnessClass witnessSet witnessHit setOutputPath setWitness failed stdstore IS_TEST " +
    "DEPLOYER A1 A2 A3 GAS_CAP ACTOR_WEI ACTOR_COUNT MAX_ARRAY_LEN BASE_TIMESTAMP BASE_BLOCK READ_FAILED Targets Classifier"
  ).split(" "),
);
const TYPE_NAME = /^(u?int\d*|bytes\d*|u?fixed\d*(x\d+)?)$/;
const isReserved = (n: string): boolean => SOLIDITY_WORDS.has(n) || HANDLER_NAMES.has(n) || TYPE_NAME.test(n);

class Names {
  private readonly used = new Set<string>();
  take(base: string): string {
    let n = base;
    while (isReserved(n) || this.used.has(n)) n += "_";
    this.used.add(n);
    return n;
  }
}

function paramBase(p: AbiParam, i: number): string {
  const raw = typeof p.name === "string" ? p.name : "";
  const s = raw.replace(/^_+/, "").replace(/[^A-Za-z0-9_$]/g, "_");
  if (s === "") return `arg${i}`;
  return /^[0-9]/.test(s) ? `_${s}` : s;
}

// ---------------------------------------------------------------------------
// Handler functions
// ---------------------------------------------------------------------------

/** External parameter types of a handler function that the replay decoder understands. */
export type HandlerParamType = "uint8" | "uint256" | "bytes";

export interface HandlerFn {
  /** Solidity name, `handler_<abi name>`. */
  name: string;
  /** The `function` string the handler writes into records ("fallback" for the fallback handlers). */
  recordName: string;
  /** External parameter types in order (including `pick`, `actorIdx` and `weiValue`). */
  paramTypes: HandlerParamType[];
  /** `0x` + 8 hex digits: the selector of `name(paramTypes)`. */
  selector: string;
  /** Solidity source of the function (indented, ends with a newline). */
  source: string;
  /** ABI function the handler calls, undefined for the fallback handlers. */
  abi?: AbiFunction;
  /** True when the function has a `Targets.targets_<recordName>()` provider. */
  hasTargets: boolean;
}

const VALUE_EXPR = "weiValue % (ACTOR_WEI + 1)";

function declsToSource(name: string, decls: string[]): string {
  const one = `    function ${name}(${decls.join(", ")}) external {`;
  if (one.length <= 120) return one;
  return `    function ${name}(\n${decls.map((d) => `        ${d}`).join(",\n")}\n    ) external {`;
}

function planFunction(f: AbiFunction): Result<HandlerFn> {
  const fname = f.name as string;
  if (!IDENT.test(fname)) return invalid(`function name ${JSON.stringify(fname)} is not a Solidity identifier`);
  const sig = signatureOf(f);
  if (!sig.ok) return sig;
  const payable = f.stateMutability === "payable";
  const names = new Names();
  const decls: string[] = ["uint256 pick", "uint8 actorIdx"];
  const types: HandlerParamType[] = ["uint256", "uint8"];
  const assigns: string[] = [];
  const locals: string[] = [];
  const args: string[] = [];

  for (const [i, p] of f.inputs.entries()) {
    const k = parseParamType(canonicalType(p) ?? "");
    if (k === undefined) {
      return invalid(
        `function ${fname}: parameter ${i} (${JSON.stringify(p.name)}) has type ${JSON.stringify(p.type)}, which the handler's parameter mapping does not support`,
        { function: fname, parameter: p.name, index: i, type: p.type },
      );
    }
    const base = names.take(paramBase(p, i));
    switch (k.kind) {
      case "scalar":
        decls.push(`uint256 ${base}`);
        types.push("uint256");
        assigns.push(`p[${i}] = ${base};`);
        args.push(castExpr(k.t, `p[${i}]`));
        break;
      case "address":
        decls.push(`uint8 ${base}`);
        types.push("uint8");
        args.push(`_addr(${base})`);
        break;
      case "addressArray": {
        const len = names.take(`${base}_len`);
        const pack = names.take(`${base}_idxPack`);
        decls.push(`uint8 ${len}`, `uint256 ${pack}`);
        types.push("uint8", "uint256");
        assigns.push(`p[${i}] = ${len};`);
        locals.push(`address[] memory ${base} = _addressArray(p[${i}], ${pack});`);
        args.push(base);
        break;
      }
      case "array": {
        const len = names.take(`${base}_len`);
        const seed = names.take(`${base}_seed`);
        decls.push(`uint8 ${len}`, `uint256 ${seed}`);
        types.push("uint8", "uint256");
        assigns.push(`p[${i}] = ${len};`);
        const T = scalarTypeName(k.elem);
        locals.push(
          `${T}[] memory ${base} = new ${T}[](_boundLen(p[${i}]));`,
          `for (uint256 j = 0; j < ${base}.length; j++) {`,
          `    ${base}[j] = ${castExpr(k.elem, `_elemSeed(${seed}, j)`)};`,
          "}",
        );
        args.push(base);
        break;
      }
      case "bytes":
      case "string":
        decls.push(`bytes calldata ${base}`);
        types.push("bytes");
        args.push(k.kind === "string" ? `string(${base})` : base);
        break;
    }
  }
  if (payable) {
    decls.push("uint256 weiValue");
    types.push("uint256");
  }

  const hasTargets = f.inputs.length > 0 || payable;
  const body: string[] = [];
  if (hasTargets) {
    body.push(`uint256[] memory p = new uint256[](${f.inputs.length});`, ...assigns);
    body.push(`_applyTargets(pick, Targets.targets_${fname}(), p);`);
  } else {
    body.push("pick;");
  }
  body.push(...locals);
  const encode = `abi.encodeWithSignature(${[JSON.stringify(sig.value), ...args].join(", ")})`;
  if (hasTargets) {
    body.push(`bytes memory cd = ${encode};`);
    body.push(`_differential("${fname}", cd, _sender(actorIdx), ${payable ? VALUE_EXPR : "0"}, ${payable});`);
  } else {
    body.push(`_differential("${fname}", ${encode}, _sender(actorIdx), 0, false);`);
  }
  const name = `handler_${fname}`;
  const source = `${declsToSource(name, decls)}\n${body.map((l) => `        ${l}`).join("\n")}\n    }\n`;
  return ok({
    name,
    recordName: fname,
    paramTypes: types,
    selector: selectorOf(`${name}(${types.join(",")})`),
    source,
    abi: f,
    hasTargets,
  });
}

function planFallbacks(abi: AbiFunction[]): HandlerFn[] {
  const fb = abi.find((f) => f.type === "fallback");
  const rx = abi.find((f) => f.type === "receive");
  const out: HandlerFn[] = [];
  const mk = (name: string, decls: string[], types: HandlerParamType[], bodyLine: string): HandlerFn => ({
    name,
    recordName: "fallback",
    paramTypes: types,
    selector: selectorOf(`${name}(${types.join(",")})`),
    source: `${declsToSource(name, decls)}\n        pick;\n        ${bodyLine}\n    }\n`,
    hasTargets: false,
  });
  if (fb !== undefined || rx !== undefined) {
    const payable = rx !== undefined || fb?.stateMutability === "payable";
    out.push(
      mk(
        "handler_fallback_empty",
        ["uint256 pick", "uint8 actorIdx", ...(payable ? ["uint256 weiValue"] : [])],
        ["uint256", "uint8", ...(payable ? (["uint256"] as const) : [])],
        `_differential("fallback", "", _sender(actorIdx), ${payable ? VALUE_EXPR : "0"}, ${payable});`,
      ),
    );
  }
  if (fb !== undefined) {
    const payable = fb.stateMutability === "payable";
    out.push(
      mk(
        "handler_fallback_unknown",
        ["uint256 pick", "uint8 actorIdx", "bytes calldata data", ...(payable ? ["uint256 weiValue"] : [])],
        ["uint256", "uint8", "bytes", ...(payable ? (["uint256"] as const) : [])],
        `_differential("fallback", _unknownCalldata(data), _sender(actorIdx), ${payable ? VALUE_EXPR : "0"}, ${payable});`,
      ),
    );
  }
  return out;
}

/** One handler function per nonpayable/payable non-constructor ABI function, then the fallback handlers. */
export function planHandlerFunctions(abi: AbiFunction[], maxStack: number = MAX_HANDLER_STACK): Result<HandlerFn[]> {
  const out: HandlerFn[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const f of abi) {
    if (f.type !== "function") continue;
    if (f.stateMutability !== "nonpayable" && f.stateMutability !== "payable") continue;
    if (typeof f.name !== "string") return invalid("ABI function entry without a name");
    if (seen.has(f.name)) {
      return invalid(
        `function ${f.name} is overloaded; the handler, the targets and the Autopsy_Report address functions by name, so overloads are not supported`,
        { function: f.name },
      );
    }
    seen.add(f.name);
    const h = planFunction(f); // validates every function, skipped or not
    if (!h.ok) return h;
    if (estimateHandlerStack(f) > maxStack) {
      skipped++;
      continue;
    }
    out.push(h.value);
  }
  out.push(...planFallbacks(abi));
  if (out.length === 0) {
    return skipped > 0
      ? invalid(
          `nothing for the handler to fuzz: every state-changing function (${skipped}) was skipped for stack depth and the ABI has no fallback`,
          { skippedForStack: skipped },
        )
      : invalid("the ABI has no state-changing function and no fallback: there is nothing for the handler to fuzz");
  }
  const names = new Set<string>();
  for (const h of out) {
    if (names.has(h.name)) return invalid(`two handler functions would be named ${h.name}`);
    names.add(h.name);
  }
  return ok(out);
}

function selectorsBody(handlers: HandlerFn[]): string {
  const lines = [`        sels = new bytes4[](${handlers.length});`];
  for (const [i, h] of handlers.entries()) lines.push(`        sels[${i}] = DifferentialHandler.${h.name}.selector;`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Seed encoder
// ---------------------------------------------------------------------------

const UINT256_MAX = (1n << 256n) - 1n;

function parseUint(text: string, what: string): Result<bigint> {
  if (typeof text !== "string" || !/^(0|[1-9]\d*|0x[0-9a-fA-F]+)$/.test(text)) {
    return invalid(`${what}: ${JSON.stringify(text)} is not a decimal or 0x-hex integer`);
  }
  const v = BigInt(text);
  return v > UINT256_MAX ? invalid(`${what}: ${text} does not fit in 256 bits`) : ok(v);
}

function seedEncoder(plan: TargetPlan, abi: AbiFunction[]): Result<string> {
  const byName = new Map<string, { fn: AbiFunction; sig: string }>();
  for (const seq of plan.seedSequences) {
    for (const call of seq) {
      const cands = abi.filter((f) => f.type === "function" && f.name === call.function && f.inputs.length === call.args.length);
      if (cands.length !== 1) {
        return invalid(
          `seed call ${call.function}: expected exactly one ABI function with ${call.args.length} parameters, found ${cands.length}`,
          { function: call.function },
        );
      }
      const fn = cands[0] as AbiFunction;
      const prev = byName.get(call.function);
      if (prev !== undefined && prev.fn !== fn) {
        return invalid(`seed calls to ${call.function} disagree on the number of arguments`);
      }
      if (prev === undefined) {
        const sig = signatureOf(fn);
        if (!sig.ok) return sig;
        byName.set(call.function, { fn, sig: sig.value });
      }
    }
  }
  const lines: string[] = [
    "    function _seedCalldata(Targets.Seed memory s) internal pure returns (bytes memory) {",
  ];
  if (byName.size === 0) {
    lines.push("        s;");
  } else {
    lines.push("        bytes32 h = keccak256(bytes(s.fn));");
    for (const [name, { fn, sig }] of byName) {
      const args: string[] = [];
      for (const [i, p] of fn.inputs.entries()) {
        const k = parseParamType(canonicalType(p) ?? "");
        if (k === undefined || k.kind === "addressArray" || k.kind === "array" || k.kind === "bytes" || k.kind === "string") {
          return invalid(`seed call ${name}: parameter ${i} has type ${JSON.stringify(p.type)}, which seed calls do not support`, {
            function: name,
            index: i,
            type: p.type,
          });
        }
        args.push(k.kind === "address" ? `_addr(uint8(s.args[${i}]))` : castExpr(k.t, `s.args[${i}]`));
      }
      lines.push(
        `        if (h == keccak256(${JSON.stringify(name)})) {`,
        `            return abi.encodeWithSignature(${[JSON.stringify(sig), ...args].join(", ")});`,
        "        }",
      );
    }
  }
  lines.push('        revert("UNKNOWN_SEED_FUNCTION");', "    }");
  return ok(lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Targets.sol
// ---------------------------------------------------------------------------

function sigHash(sig: string): string {
  return `bytes4(keccak256(${JSON.stringify(sig)}))`;
}

const isView = (f: AbiFunction): boolean => f.stateMutability === "view" || f.stateMutability === "pure";
const hasOutputs = (f: AbiFunction): boolean => (f.outputs?.length ?? 0) > 0;
const typesAre = (f: AbiFunction, ...t: string[]): boolean =>
  f.inputs.length === t.length && f.inputs.every((p, i) => p.type === t[i]);

function getterSection(abi: AbiFunction[], match: (f: AbiFunction) => boolean, fname: string): Result<string> {
  const gs = abi.filter((f) => f.type === "function" && isView(f) && hasOutputs(f) && match(f));
  const lines = [`    function ${fname}() internal pure returns (Getter[] memory g) {`, `        g = new Getter[](${gs.length});`];
  for (const [i, f] of gs.entries()) {
    const sig = signatureOf(f);
    if (!sig.ok) return sig;
    lines.push(`        g[${i}] = Getter({name: ${JSON.stringify(f.name)}, selector: ${sigHash(sig.value)}});`);
  }
  lines.push("    }");
  return ok(lines.join("\n"));
}

function entryExpr(e: TargetEntry, fn: string): Result<{ stmt: (i: number) => string }> {
  const as: { p: number; k: string; v: bigint }[] = [];
  for (const a of e.assignments) {
    if (!Number.isInteger(a.slot.paramIndex) || a.slot.paramIndex < 0 || a.slot.paramIndex > 255) {
      return invalid(`targets for ${fn}: parameter index ${a.slot.paramIndex} is out of range`);
    }
    if (typeof a.value !== "bigint" || a.value < 0n || a.value > UINT256_MAX) {
      return invalid(`targets for ${fn}: value ${String(a.value)} is not a uint256`);
    }
    as.push({ p: a.slot.paramIndex, k: a.slot.encoding === "static" ? "KIND_STATIC" : "KIND_ARRAY_LEN", v: a.value });
  }
  return ok({
    stmt: (i) => {
      if (as.length === 0) return `        // e[${i}]: no assignments, the call uses fuzzed values`;
      if (as.length === 1) return `        e[${i}] = _entry1(${as[0]!.p}, ${as[0]!.k}, ${as[0]!.v});`;
      if (as.length === 2) {
        return `        e[${i}] = _entry2(${as[0]!.p}, ${as[0]!.k}, ${as[0]!.v}, ${as[1]!.p}, ${as[1]!.k}, ${as[1]!.v});`;
      }
      const inner = as.map((a, j) => `            a[${j}] = Assign(${a.p}, ${a.k}, ${a.v});`).join("\n");
      return `        {\n            Assign[] memory a = new Assign[](${as.length});\n${inner}\n            e[${i}] = Entry(a);\n        }`;
    },
  });
}

function parseFunding(v: GeneratorOptions["fundingWei"]): Result<bigint> {
  if (v === undefined) return ok(0n);
  try {
    const n = typeof v === "bigint" ? v : BigInt(v);
    if (n < 0n || n > UINT256_MAX) return invalid("fundingWei must be in 0..2^256-1");
    return ok(n);
  } catch {
    return invalid("fundingWei must be an integer");
  }
}

function renderTargets(
  input: SeanceInput,
  plan: TargetPlan,
  abi: AbiFunction[],
  handlers: HandlerFn[],
  funding: bigint,
): Result<string> {
  const name = input.contractName;
  const fns = abi.filter((f) => f.type === "function");
  const hasTransfer = fns.some((f) => f.name === "transfer" && typesAre(f, "address", "uint256") && f.stateMutability === "nonpayable");
  const hasBalanceOf = fns.some((f) => f.name === "balanceOf" && typesAre(f, "address"));
  const ctor = (input.constructorArgs ?? "0x").slice(2).toLowerCase();

  // Seeds
  const seeds: SeedCall[] = plan.seedSequences.flat();
  const seedLines: string[] = [`    function seeds() internal pure returns (Seed[] memory s) {`, `        s = new Seed[](${seeds.length});`];
  for (const [i, c] of seeds.entries()) {
    if (!Number.isInteger(c.actorIdx) || c.actorIdx < 0 || c.actorIdx > 255) {
      return invalid(`seed call ${c.function}: actorIdx ${c.actorIdx} must be an integer in 0..255`);
    }
    let value = 0n;
    if (c.value !== undefined) {
      const v = parseUint(c.value, `seed call ${c.function} value`);
      if (!v.ok) return v;
      value = v.value;
    }
    if (!IDENT.test(c.function)) return invalid(`seed call function ${JSON.stringify(c.function)} is not an identifier`);
    seedLines.push("        {", `            uint256[] memory a = new uint256[](${c.args.length});`);
    for (const [j, a] of c.args.entries()) {
      const v = parseUint(a, `seed call ${c.function} argument ${j}`);
      if (!v.ok) return v;
      seedLines.push(`            a[${j}] = ${v.value};`);
    }
    seedLines.push(
      `            s[${i}] = Seed({fn: ${JSON.stringify(c.function)}, actorIdx: ${c.actorIdx}, value: ${value}, args: a});`,
      "        }",
    );
  }
  seedLines.push("    }");

  const g0 = getterSection(abi, (f) => f.inputs.length === 0, "noArgGetters");
  if (!g0.ok) return g0;
  const g1 = getterSection(abi, (f) => typesAre(f, "address"), "addrGetters");
  if (!g1.ok) return g1;
  const g2 = getterSection(abi, (f) => typesAre(f, "address", "address"), "pairGetters");
  if (!g2.ok) return g2;

  const sigs: string[] = [];
  for (const f of fns) {
    const s = signatureOf(f);
    if (!s.ok) return s;
    sigs.push(s.value);
  }
  const known =
    sigs.length === 0
      ? ["    function isKnownSelector(bytes4 sel) internal pure returns (bool) {", "        sel;", "        return false;", "    }"]
      : [
          "    function isKnownSelector(bytes4 sel) internal pure returns (bool) {",
          `        return ${sigs.map((s, i) => `${i === 0 ? "" : "            || "}sel == ${sigHash(s)}`).join("\n")};`,
          "    }",
        ];

  // targets_<fn>
  const targetFns: string[] = [];
  for (const h of handlers) {
    if (!h.hasTargets) continue;
    const entries: TargetEntry[] = [];
    const siteIds: string[] = [];
    for (const s of plan.sites) {
      if (s.functionName !== h.recordName) continue;
      siteIds.push(s.siteId);
      entries.push(...s.entries);
    }
    const nParams = h.abi?.inputs.length ?? 0;
    const body: string[] = [];
    for (const [i, e] of entries.entries()) {
      for (const a of e.assignments) {
        if (a.slot.paramIndex >= nParams) {
          return invalid(`targets for ${h.recordName}: parameter index ${a.slot.paramIndex} but the function has ${nParams} parameters`);
        }
      }
      const r = entryExpr(e, h.recordName);
      if (!r.ok) return r;
      body.push(r.value.stmt(i));
    }
    targetFns.push(
      [
        `    /// ${h.recordName}: ${entries.length} entries from ${siteIds.length === 0 ? "no sites" : `site${siteIds.length === 1 ? "" : "s"} ${siteIds.join(", ")}`}.`,
        `    function targets_${h.recordName}() internal pure returns (Entry[] memory e) {`,
        `        e = new Entry[](${entries.length});`,
        ...body,
        "    }",
      ].join("\n"),
    );
  }
  // Sites naming a function that has no handler (view functions) have nothing to target; nothing to emit.

  const out = [
    "// SPDX-License-Identifier: MIT",
    `pragma solidity ${PORT_SOLC_VERSION};`,
    "",
    "// Generated by the Exhume Project_Generator. Do not edit.",
    "library Targets {",
    `    string internal constant LEGACY_ARTIFACT = ${JSON.stringify(`Legacy${name}.sol:${name}`)};`,
    `    string internal constant PORT_ARTIFACT = ${JSON.stringify(`Port${name}.sol:${name}`)};`,
    `    bool internal constant HAS_TOKEN_SHARES = ${hasTransfer && hasBalanceOf}; // ABI has transfer(address,uint256) and balanceOf(address)`,
    `    uint256 internal constant FUNDING_WEI = ${funding};`,
    "    uint8 internal constant KIND_STATIC = 0; // ParamSlot.encoding \"static\"",
    "    uint8 internal constant KIND_ARRAY_LEN = 1; // ParamSlot.encoding \"dynamicArrayLength\"",
    "",
    "    struct Assign {",
    "        uint8 paramIndex;",
    "        uint8 kind;",
    "        uint256 value;",
    "    }",
    "",
    "    struct Entry {",
    "        Assign[] assigns;",
    "    }",
    "",
    "    /// Address arguments are Actor_Set indices (0..4), the other arguments plain integers.",
    "    struct Seed {",
    "        string fn;",
    "        uint8 actorIdx;",
    "        uint256 value;",
    "        uint256[] args;",
    "    }",
    "",
    "    struct Getter {",
    "        string name;",
    "        bytes4 selector;",
    "    }",
    "",
    "    function ctorArgs() internal pure returns (bytes memory) {",
    `        return hex"${ctor}";`,
    "    }",
    "",
    "    /// Seed sequences, flattened in order.",
    ...seedLines,
    "",
    g0.value,
    "",
    g1.value,
    "",
    g2.value,
    "",
    ...known,
    "",
    ...targetFns.flatMap((t) => [t, ""]),
    "    function _entry1(uint8 p0, uint8 k0, uint256 v0) private pure returns (Entry memory e) {",
    "        e.assigns = new Assign[](1);",
    "        e.assigns[0] = Assign(p0, k0, v0);",
    "    }",
    "",
    "    function _entry2(uint8 p0, uint8 k0, uint256 v0, uint8 p1, uint8 k1, uint256 v1) private pure returns (Entry memory e) {",
    "        e.assigns = new Assign[](2);",
    "        e.assigns[0] = Assign(p0, k0, v0);",
    "        e.assigns[1] = Assign(p1, k1, v1);",
    "    }",
    "}",
    "",
  ];
  return ok(out.join("\n"));
}

// ---------------------------------------------------------------------------
// Witness and replay files
// ---------------------------------------------------------------------------

function witnessFile(handlers: HandlerFn[], pairs: WitnessPair[]): Result<string> {
  if (pairs.length > MAX_WITNESS_PAIRS) return invalid(`at most ${MAX_WITNESS_PAIRS} witness pairs, got ${pairs.length}`);
  const known = new Set(handlers.map((h) => h.recordName));
  const lines: string[] = [];
  for (const [i, p] of pairs.entries()) {
    if (!known.has(p.function)) {
      return invalid(`witness pair ${i + 1}: ${JSON.stringify(p.function)} is not a handler function of this contract`, { function: p.function });
    }
    if (p.classification !== "exorcised" && p.classification !== "port-bug") {
      return invalid(`witness pair ${i + 1}: classification must be "exorcised" or "port-bug"`);
    }
    const cls = p.classification === "exorcised" ? "Exorcised" : "PortBug";
    lines.push(`        if (k == ${i + 1}) return (${JSON.stringify(p.function)}, Classifier.Class.${cls});`);
  }
  let t = loadTemplate("Witness.t.sol");
  t = fillMarker(t, "HANDLER_SELECTORS", selectorsBody(handlers));
  t = lines.length === 0 ? fillMarker(t, "WITNESS_PAIRS", "        // no witness pairs") : fillMarker(t, "WITNESS_PAIRS", lines.join("\n"));
  return ok(t);
}

type DecodedArg = bigint | string;

/** Decodes the arguments of a handler call (after the selector) given the handler's external types. */
function decodeArgs(types: HandlerParamType[], calldata: string): Result<DecodedArg[]> {
  const body = calldata.slice(10);
  if (!/^[0-9a-fA-F]*$/.test(body) || body.length % 2 !== 0) return failed("calldata is not even-length hex");
  const bytes = body.length / 2;
  const word = (i: number): bigint | undefined =>
    32 * (i + 1) <= bytes ? BigInt("0x" + body.slice(64 * i, 64 * (i + 1))) : undefined;
  const hasDynamic = types.includes("bytes");
  if (bytes < 32 * types.length || (!hasDynamic && bytes !== 32 * types.length)) {
    return failed(`calldata has ${bytes} argument bytes, the signature needs ${32 * types.length}${hasDynamic ? " or more" : ""}`);
  }
  const out: DecodedArg[] = [];
  for (const [i, t] of types.entries()) {
    const w = word(i) as bigint;
    if (t === "uint256") out.push(w);
    else if (t === "uint8") {
      if (w > 255n) return failed(`argument ${i}: ${w} does not fit in uint8`);
      out.push(w);
    } else {
      const off = Number(w);
      if (w > BigInt(bytes) || off % 32 !== 0 || off + 32 > bytes) return failed(`argument ${i}: bad bytes offset ${w}`);
      const len = BigInt("0x" + body.slice(2 * off, 2 * off + 64));
      if (len > BigInt(bytes)) return failed(`argument ${i}: bytes length ${len} exceeds the calldata`);
      const start = 2 * (off + 32);
      const end = start + 2 * Number(len);
      if (end > body.length) return failed(`argument ${i}: bytes data is truncated`);
      out.push(body.slice(start, end).toLowerCase());
    }
  }
  return ok(out);
}

function replayStatement(h: HandlerFn, call: ShrunkCall): Result<string> {
  const cd = call.calldata;
  if (typeof cd !== "string" || !/^0x[0-9a-fA-F]{8,}$/.test(cd)) return failed(`call ${call.func_name}: calldata is not 0x-hex with a selector`);
  if (cd.slice(0, 10).toLowerCase() !== h.selector) {
    return failed(`call ${call.func_name}: selector ${cd.slice(0, 10)} is not the selector ${h.selector} of ${h.name}(${h.paramTypes.join(",")})`, {
      function: call.func_name,
    });
  }
  const args = decodeArgs(h.paramTypes, cd);
  if (!args.ok) return failed(`call ${call.func_name}: ${args.error.message}`, { function: call.func_name });
  const text = args.value.map((a) => (typeof a === "bigint" ? a.toString(10) : `hex"${a}"`));
  return ok(`        handler.${h.name}(${text.join(", ")});`);
}

function replayFile(handlers: HandlerFn[], sequences: ShrunkSequence[]): Result<string> {
  const byName = new Map(handlers.map((h) => [h.name, h]));
  const seen = new Set<number>();
  let t = loadTemplate("Replay.t.sol");
  for (const s of sequences) {
    if (!Number.isInteger(s.k) || s.k < 1 || s.k > MAX_WITNESS_PAIRS) return failed(`replay index ${s.k} must be an integer in 1..${MAX_WITNESS_PAIRS}`);
    if (seen.has(s.k)) return failed(`replay index ${s.k} appears twice`);
    seen.add(s.k);
    if (s.calls.length === 0) continue; // nothing to bake in: the marker line stays
    const lines: string[] = [];
    for (const c of s.calls) {
      const h = byName.get(c.func_name);
      if (h === undefined) return failed(`replay ${s.k}: ${JSON.stringify(c.func_name)} is not a handler function of this project`, { function: c.func_name });
      const st = replayStatement(h, c);
      if (!st.ok) return st;
      lines.push(st.value);
    }
    t = fillMarker(t, `REPLAY_CALLS_${s.k}`, lines.join("\n"));
  }
  return ok(t);
}

function replaceFile(project: ProjectFiles, path: string, contents: string): Result<ProjectFiles> {
  if (!project.some((f) => f.path === path)) return failed(`project has no ${path}`);
  return ok(project.map((f) => (f.path === path ? { path, contents } : f)));
}

/** Guards template reads (a missing templates dir is an engine fault, not a thrown exception). */
function guarded<T>(f: () => Result<T>): Result<T> {
  try {
    return f();
  } catch (e) {
    return failed(`project generation failed: ${(e as Error).message}`);
  }
}

/**
 * Returns `project` with only `test/Witness.t.sol` regenerated, with `pairs` (k = index + 1) written into
 * `_pair`. The Runner calls this after discovery, before the witness campaigns.
 */
export function regenerateWitness(project: ProjectFiles, abi: AbiFunction[], pairs: WitnessPair[]): Result<ProjectFiles> {
  return guarded(() => {
    const handlers = planHandlerFunctions(abi);
    if (!handlers.ok) return handlers;
    const w = witnessFile(handlers.value, pairs);
    if (!w.ok) return w;
    return replaceFile(project, PATHS.witness, w.value);
  });
}

/**
 * Returns `project` with only `test/Replay.t.sol` regenerated: each sequence's calls (from forge's
 * `counterexample.Sequence[1]`) are decoded with the handler function signatures and written as
 * `handler.handler_<fn>(...)` statements into `SeanceReplay<k>.test_replay`. Always built from the pristine
 * template, so the result depends only on `sequences`.
 */
export function regenerateReplay(project: ProjectFiles, abi: AbiFunction[], sequences: ShrunkSequence[]): Result<ProjectFiles> {
  return guarded(() => {
    const handlers = planHandlerFunctions(abi);
    if (!handlers.ok) return handlers;
    const r = replayFile(handlers.value, sequences);
    if (!r.ok) return r;
    return replaceFile(project, PATHS.replay, r.value);
  });
}

// ---------------------------------------------------------------------------
// generateSrcProject / generateTestProject / generateProject
// ---------------------------------------------------------------------------

const byPath = (a: ProjectFile, b: ProjectFile): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Output of the stage that knows the ABI. `skippedFunctions` is sorted by name, without duplicates. */
export interface GeneratedProject {
  files: ProjectFiles;
  skippedFunctions: SkippedFunction[];
}

/**
 * Stage 1: `src/legacy`, `src/port`, `foundry.toml` and `remappings.txt`. Needs only the input (no ABI, no
 * plan), so the Runner can build before it knows the ABI. Validates `rawInput` first.
 */
export function generateSrcProject(rawInput: SeanceInput, opts: GeneratorOptions = {}): Result<ProjectFiles> {
  return guarded(() => {
    const v = validateInput(rawInput);
    if (!v.ok) return v;
    const input = v.value;
    const forgeStdDir = opts.forgeStdDir ?? FORGE_STD_DEFAULT_DIR;
    const toml = renderFoundryToml({
      contractName: input.contractName,
      legacySolcVersion: input.legacySolcVersion,
      legacyOptimizer: {
        enabled: input.legacyOptimizer,
        ...(input.legacyOptimizerRuns !== undefined && { runs: input.legacyOptimizerRuns }),
      },
      forgeStdDir,
      ...(opts.portSharesLegacyOptimizer !== undefined && { portSharesLegacyOptimizer: opts.portSharesLegacyOptimizer }),
    });
    if (!toml.ok) return toml;
    const files: ProjectFiles = [
      { path: PATHS.foundryToml, contents: toml.value },
      { path: PATHS.remappings, contents: remappingsText(forgeStdDir) },
      { path: legacyPath(input.contractName), contents: input.legacySource },
      { path: portPath(input.contractName), contents: input.portSource },
    ];
    files.sort(byPath);
    return ok(files);
  });
}

/** Drops seed calls naming a skipped function, and sequences that become empty. */
function withoutSkippedSeeds(plan: TargetPlan, skipped: ReadonlySet<string>): TargetPlan {
  if (skipped.size === 0) return plan;
  const seedSequences = plan.seedSequences
    .map((seq) => seq.filter((c) => !skipped.has(c.function)))
    .filter((seq) => seq.length > 0);
  return { ...plan, seedSequences };
}

/**
 * Stage 2: every file under `test/`, from the ABI and the TargetPlan (`witnessPairs` optional). Functions whose
 * stack estimate is above the limit get no handler (see the module comment) and are returned in
 * `skippedFunctions`; seed calls naming them are dropped. Validates `rawInput` first.
 */
export function generateTestProject(
  rawInput: SeanceInput,
  plan: TargetPlan,
  abi: AbiFunction[],
  opts: GeneratorOptions = {},
): Result<GeneratedProject> {
  return guarded(() => {
    const v = validateInput(rawInput);
    if (!v.ok) return v;
    const input = v.value;
    const max = opts.maxHandlerStack ?? MAX_HANDLER_STACK;

    const funding = parseFunding(opts.fundingWei);
    if (!funding.ok) return funding;
    const handlers = planHandlerFunctions(abi, max);
    if (!handlers.ok) return handlers;
    const skippedFunctions = computeSkippedFunctions(abi, max);
    const livePlan = withoutSkippedSeeds(plan, new Set(skippedFunctions.map((s) => s.name)));
    const enc = seedEncoder(livePlan, abi);
    if (!enc.ok) return enc;
    const targets = renderTargets(input, livePlan, abi, handlers.value, funding.value);
    if (!targets.ok) return targets;
    const witness = witnessFile(handlers.value, opts.witnessPairs ?? []);
    if (!witness.ok) return witness;
    const replay = replayFile(handlers.value, []);
    if (!replay.ok) return replay;

    let handler = loadTemplate("Handler.sol");
    handler = fillMarker(handler, "SEED_ENCODER", enc.value);
    handler = fillMarker(handler, "HANDLER_FUNCTIONS", handlers.value.map((h) => h.source).join("\n"));
    const seance = fillMarker(loadTemplate("Seance.t.sol"), "HANDLER_SELECTORS", selectorsBody(handlers.value));

    const files: ProjectFiles = [
      { path: PATHS.handler, contents: handler },
      { path: PATHS.classifier, contents: loadTemplate("Classifier.sol") },
      { path: PATHS.targets, contents: targets.value },
      { path: PATHS.seance, contents: seance },
      { path: PATHS.witness, contents: witness.value },
      { path: PATHS.replay, contents: replay.value },
    ];
    files.sort(byPath);
    return ok({ files, skippedFunctions });
  });
}

/**
 * Both stages: the union of the two file lists, sorted by path. Nothing is produced for an invalid input.
 * `plan` comes from `generateTargets`, `abi` from `loadAbi`.
 */
export function generateProject(
  rawInput: SeanceInput,
  plan: TargetPlan,
  abi: AbiFunction[],
  opts: GeneratorOptions = {},
): Result<GeneratedProject> {
  const src = generateSrcProject(rawInput, opts);
  if (!src.ok) return src;
  const test = generateTestProject(rawInput, plan, abi, opts);
  if (!test.ok) return test;
  const files = [...src.value, ...test.value.files].sort(byPath);
  return ok({ files, skippedFunctions: test.value.skippedFunctions });
}

// ---------------------------------------------------------------------------
// writeProject
// ---------------------------------------------------------------------------

/** Checks the file list without touching the disk. */
export function validateProjectFiles(project: ProjectFiles): Result<void> {
  if (!Array.isArray(project) || project.length === 0) return invalid("project has no files");
  let prev: string | undefined;
  for (const f of project) {
    if (typeof f?.path !== "string" || typeof f.contents !== "string") return invalid("project file without a string path and contents");
    const p = f.path;
    const segs = p.split("/");
    if (p === "" || p.startsWith("/") || p.includes("\\") || p.includes("\0") || segs.some((s) => s === "" || s === "." || s === "..")) {
      return invalid(`project path ${JSON.stringify(p)} must be relative, with no empty, "." or ".." segments`);
    }
    if (segs[0] === "lib") return invalid(`project path ${JSON.stringify(p)} is under lib/; generated projects have no lib/`);
    if (prev !== undefined && !(prev < p)) return invalid(`project paths must be unique and sorted: ${JSON.stringify(prev)} then ${JSON.stringify(p)}`);
    prev = p;
  }
  return ok(undefined);
}

export type WriteMode = "fresh" | "add";

/** Throws unless `full` stays inside `root` once the existing part of its path is resolved (no symlink escapes). */
function assertInside(root: string, full: string): void {
  let probe = full;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  const rootReal = realpathSync(root);
  if (real !== rootReal && !real.startsWith(rootReal + sep)) throw new Error(`${full} resolves outside ${root}`);
}

/**
 * Writes `files` to `dir`. Validates the list first (relative, no `..`, sorted, unique, no `lib/`) and writes
 * nothing when it is invalid.
 *
 * - `mode: "fresh"`: `dir` must not exist or be an empty directory (an existing project is never
 *   overwritten: design decision 15). The files are written to a sibling staging directory and renamed into
 *   place, so a failure leaves no partial project at `dir`.
 * - `mode: "add"`: `dir` must be an existing directory (the first stage was written there). Every path must be
 *   free: the call refuses, writing nothing, if any file already exists (it never overwrites). New files and
 *   directories are removed again if the write fails halfway.
 */
export function writeProjectFiles(dir: string, files: ProjectFiles, opts: { mode: WriteMode }): Result<void> {
  const valid = validateProjectFiles(files);
  if (!valid.ok) return valid;
  const target = resolve(dir);
  if (opts.mode === "fresh") return writeFresh(target, files);
  if (opts.mode !== "add") return invalid(`unknown write mode ${JSON.stringify(opts.mode)}`);
  if (!existsSync(target) || !statSync(target).isDirectory()) return invalid(`${target} is not an existing directory`);
  const created: string[] = [];
  try {
    for (const f of files) {
      const full = resolve(target, f.path);
      assertInside(target, full);
      if (lstatExists(full)) return invalid(`refusing to overwrite ${f.path} in ${target}`, { path: f.path });
    }
    for (const f of files) {
      const full = resolve(target, f.path);
      let d = dirname(full);
      const newDirs: string[] = [];
      while (!existsSync(d)) {
        newDirs.unshift(d);
        d = dirname(d);
      }
      for (const nd of newDirs) {
        mkdirSync(nd);
        created.push(nd);
      }
      writeFileSync(full, f.contents, { flag: "wx" });
      created.push(full);
    }
    return ok(undefined);
  } catch (e) {
    for (const c of created.reverse()) rmSync(c, { recursive: true, force: true });
    return failed(`could not add files to ${target}: ${(e as Error).message}`);
  }
}

function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function writeFresh(target: string, project: ProjectFiles): Result<void> {
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) return invalid(`${target} exists and is not a directory`);
    if (readdirSync(target).length > 0) return invalid(`refusing to write into ${target}: it is not empty`);
  }
  let staging: string | undefined;
  try {
    mkdirSync(dirname(target), { recursive: true });
    staging = mkdtempSync(`${target}.staging-`);
    for (const f of project) {
      const full = resolve(staging, f.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, f.contents);
    }
    chmodSync(staging, 0o755);
    if (existsSync(target)) rmdirSync(target);
    renameSync(staging, target);
    staging = undefined;
    return ok(undefined);
  } catch (e) {
    return failed(`could not write the project to ${target}: ${(e as Error).message}`);
  } finally {
    if (staging !== undefined) rmSync(staging, { recursive: true, force: true });
  }
}

/** Writes a whole project into a new or empty directory (`writeProjectFiles` with `mode: "fresh"`). */
export function writeProject(dir: string, project: ProjectFiles): Result<void> {
  return writeProjectFiles(dir, project, { mode: "fresh" });
}

/** Generates, then writes. Nothing is written when generation fails. */
export function generateAndWriteProject(
  dir: string,
  input: SeanceInput,
  plan: TargetPlan,
  abi: AbiFunction[],
  opts: GeneratorOptions = {},
): Result<GeneratedProject> {
  const g = generateProject(input, plan, abi, opts);
  if (!g.ok) return g;
  const w = writeProject(dir, g.value.files);
  return w.ok ? g : w;
}
