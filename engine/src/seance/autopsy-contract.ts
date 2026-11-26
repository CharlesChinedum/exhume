/**
 * Autopsy contract: parse, validate and serialize Autopsy reports (Requirement 11).
 *
 * `parseAutopsyReport` checks, in this order, and stops at the first failing
 * category: empty, over 10 MB, JSON syntax, `schemaVersion` present,
 * `schemaVersion` supported, JSON-schema violations (all of them, with JSON
 * pointers), unknown ABI functions (all of them). Every failure is an
 * `AUTOPSY_REJECTED` error whose `details.reason` names the category.
 */
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import {
  err,
  ok,
  seanceError,
  type AbiFunction,
  type ArithmeticSite,
  type AutopsyReport,
  type Operand,
  type Result,
  type SeanceError,
} from "./types.js";

/** Schema versions this engine accepts. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly string[] = ["1"];

/** "10 MB" as in Requirement 11.10, taken as 10 * 1024 * 1024 bytes of UTF-8. */
export const MAX_AUTOPSY_BYTES = 10 * 1024 * 1024;

export type AutopsyRejectReason =
  | "empty"
  | "too-large"
  | "invalid-json"
  | "schema-version-missing"
  | "schema-version-unsupported"
  | "schema-violations"
  | "unknown-functions";

export interface SchemaViolation {
  /** JSON pointer into the document; "" is the root. */
  pointer: string;
  keyword: string;
  message: string;
}

export interface UnknownFunction {
  function: string;
  siteIds: string[];
}

function reject(reason: AutopsyRejectReason, message: string, extra: Record<string, unknown> = {}) {
  return err<SeanceError>(seanceError("AUTOPSY_REJECTED", message, { reason, ...extra }));
}

// ---------------------------------------------------------------------------
// Schema validator, compiled once
// ---------------------------------------------------------------------------

function compileValidator(): ValidateFunction {
  const schema = JSON.parse(
    readFileSync(new URL("./schemas/autopsy-v1.schema.json", import.meta.url), "utf8"),
  ) as object;
  const ajv = new Ajv2020.default({ allErrors: true, strict: true, strictRequired: true });
  return ajv.compile(schema);
}

const validate: ValidateFunction = compileValidator();

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toViolations(errors: ErrorObject[]): SchemaViolation[] {
  const seen = new Set<string>();
  const out: (SchemaViolation & { params: string })[] = [];
  for (const e of errors) {
    const params = JSON.stringify(e.params);
    const key = `${e.instancePath}\u0000${e.keyword}\u0000${e.message ?? ""}\u0000${params}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pointer: e.instancePath, keyword: e.keyword, message: e.message ?? "", params });
  }
  out.sort(
    (a, b) =>
      cmp(a.pointer, b.pointer) || cmp(a.keyword, b.keyword) || cmp(a.message, b.message) || cmp(a.params, b.params),
  );
  return out.map(({ pointer, keyword, message }) => ({ pointer, keyword, message }));
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export function parseAutopsyReport(text: string, legacyAbi: AbiFunction[]): Result<AutopsyReport, SeanceError> {
  // (1) empty
  if (text.trim() === "") {
    return reject("empty", "Autopsy report is empty");
  }
  // (2) size
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_AUTOPSY_BYTES) {
    return reject("too-large", `Autopsy report is ${bytes} bytes, over the limit of ${MAX_AUTOPSY_BYTES} bytes (10 MB)`, {
      bytes,
      limit: MAX_AUTOPSY_BYTES,
    });
  }
  // (3) JSON syntax
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    const parserMessage = e instanceof Error ? e.message : String(e);
    const pos = /position (\d+)/.exec(parserMessage);
    return reject("invalid-json", `Autopsy report is not valid JSON: ${parserMessage}`, {
      parserMessage,
      ...(pos?.[1] !== undefined && { position: Number(pos[1]) }),
    });
  }
  // (4) schemaVersion present. A non-object document cannot carry the field.
  const isObject = typeof doc === "object" && doc !== null && !Array.isArray(doc);
  if (!isObject || !Object.hasOwn(doc as object, "schemaVersion")) {
    return reject("schema-version-missing", "Autopsy report is missing the `schemaVersion` field", {
      field: "schemaVersion",
    });
  }
  // (5) schemaVersion supported
  const version = (doc as Record<string, unknown>)["schemaVersion"];
  if (typeof version !== "string" || !SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
    const found = JSON.stringify(version);
    return reject(
      "schema-version-unsupported",
      `Autopsy report schemaVersion ${found} is not supported (supported: ${SUPPORTED_SCHEMA_VERSIONS.map((v) => JSON.stringify(v)).join(", ")})`,
      { found: version, supported: [...SUPPORTED_SCHEMA_VERSIONS] },
    );
  }
  // (6) schema
  if (!validate(doc)) {
    const violations = toViolations(validate.errors ?? []);
    const listing = violations.map((v) => `${v.pointer === "" ? "(root)" : v.pointer}: ${v.message}`).join("; ");
    return reject(
      "schema-violations",
      `Autopsy report violates the schema (${violations.length} violation${violations.length === 1 ? "" : "s"}): ${listing}`,
      { violations },
    );
  }
  const report = doc as AutopsyReport;
  // (7) ABI cross-check: only `function` entries can be named by a site.
  const known = new Set<string>();
  for (const entry of legacyAbi) {
    if (entry.type === "function" && entry.name !== undefined) known.add(entry.name);
  }
  const unknownMap = new Map<string, string[]>();
  for (const site of report.sites) {
    if (known.has(site.function)) continue;
    const ids = unknownMap.get(site.function);
    if (ids === undefined) unknownMap.set(site.function, [site.id]);
    else ids.push(site.id);
  }
  if (unknownMap.size > 0) {
    const unknownFunctions: UnknownFunction[] = [...unknownMap.keys()]
      .sort(cmp)
      .map((fn) => ({ function: fn, siteIds: [...new Set(unknownMap.get(fn))].sort(cmp) }));
    const names = unknownFunctions.map((u) => u.function).join(", ");
    return reject("unknown-functions", `Autopsy report names functions missing from the legacy ABI: ${names}`, {
      unknownFunctions,
    });
  }
  return ok(report);
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

function canonOperand(o: Operand): Record<string, unknown> {
  switch (o.kind) {
    case "known":
      return { kind: o.kind, value: o.value, type: o.type };
    case "param":
    case "arrayLength":
      return { kind: o.kind, name: o.name, type: o.type };
    case "unknown":
      return { kind: o.kind, type: o.type };
  }
}

function canonSite(s: ArithmeticSite): Record<string, unknown> {
  return {
    id: s.id,
    function: s.function,
    operator: s.operator,
    operands: [canonOperand(s.operands[0]), canonOperand(s.operands[1])],
    location: { file: s.location.file, line: s.location.line, column: s.location.column },
    ...(s.precondition !== undefined && {
      precondition: s.precondition.map((p) => ({ kind: p.kind, ...(p.hint !== undefined && { hint: p.hint }) })),
    }),
  };
}

/**
 * Canonical JSON: fixed key order (schema order), arrays keep their order,
 * 2-space indent, trailing LF. The design only says "canonical key order";
 * indent and LF match `serializeReport`.
 */
export function serializeAutopsyReport(r: AutopsyReport): string {
  const canon = {
    schemaVersion: r.schemaVersion,
    contract: r.contract,
    sites: r.sites.map(canonSite),
  };
  return JSON.stringify(canon, null, 2) + "\n";
}
