/**
 * ABI loader: normalises a solc JSON ABI array into `AbiFunction[]`.
 *
 * Keeps `function`, `constructor`, `fallback` and `receive` entries in input
 * order and silently drops `event`, `error` and any other entry type.
 * Pre-0.4.16 ABIs have no `stateMutability`; it is derived from the legacy
 * `payable` / `constant` flags (payable wins over constant).
 */
import { err, ok, seanceError, type AbiFunction, type AbiParam, type Result } from "./types.js";

const KEPT_TYPES: readonly string[] = ["function", "constructor", "fallback", "receive"];
const MUTABILITIES: readonly string[] = ["pure", "view", "nonpayable", "payable"];

function bad(index: number, why: string) {
  return err(seanceError("INVALID_INPUT", `ABI entry ${index}: ${why}`));
}

export function loadAbi(raw: unknown): Result<AbiFunction[]> {
  if (!Array.isArray(raw)) {
    return err(seanceError("INVALID_INPUT", "ABI must be a JSON array"));
  }
  const out: AbiFunction[] = [];
  for (const [i, entry] of (raw as unknown[]).entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return bad(i, "not an object");
    }
    const e = entry as Record<string, unknown>;
    if (typeof e["type"] !== "string") return bad(i, "`type` must be a string");
    if (!KEPT_TYPES.includes(e["type"])) continue;

    if (e["type"] === "function" && (typeof e["name"] !== "string" || e["name"] === "")) {
      return bad(i, "function entry requires a non-empty `name`");
    }
    if (e["inputs"] !== undefined && !Array.isArray(e["inputs"])) {
      return bad(i, "`inputs` must be an array");
    }
    const inputs = (e["inputs"] ?? []) as AbiParam[];

    let stateMutability: AbiFunction["stateMutability"];
    const sm = e["stateMutability"];
    if (sm === undefined) {
      stateMutability = e["payable"] === true ? "payable" : e["constant"] === true ? "view" : "nonpayable";
    } else if (typeof sm === "string" && MUTABILITIES.includes(sm)) {
      stateMutability = sm as AbiFunction["stateMutability"];
    } else {
      return bad(i, "invalid `stateMutability`");
    }

    out.push({ ...(e as unknown as AbiFunction), inputs, stateMutability });
  }
  return ok(out);
}
