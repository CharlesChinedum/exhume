/**
 * Divergence taint: recomputes `afterDivergence` and cross-checks the handler.
 * Pure: no clock, randomness, I/O, or mutation of inputs. Messages are ASCII.
 *
 * Rule (Requirement 5.5, design decision 7): a record is tainted when
 * `setupDiverged` is true, or when an earlier record of the same sequence is a
 * `port-bug`. The first `port-bug` itself is not tainted. Later records are
 * tainted whatever their class. `match`, `reason-modernised` and `exorcised`
 * never taint on their own.
 */
import type { Classification, OrderedRecord, RecordLine, Result, SeanceError } from "./types.js";
import { err, ok, seanceError } from "./types.js";

/**
 * One flag per element of `sequence`, in order. `setupDiverged` is false for
 * the setup sequence itself (design); true for fuzz sequences when any setup
 * record is a `port-bug`.
 */
export function computeTaint(sequence: readonly { classification: Classification }[], setupDiverged: boolean): boolean[] {
  let diverged = setupDiverged;
  return sequence.map((r) => {
    const flag = diverged;
    if (r.classification === "port-bug") diverged = true;
    return flag;
  });
}

/**
 * Splits the stream (in the order given, never reordered) into the setup group
 * (`idx == -1`) and fuzz sequences (a new sequence starts at each `idx == 0`),
 * recomputes the flags, and fails with `SEANCE_FAILED` on the first record
 * (stream order) whose `afterDivergence` differs.
 *
 * Choices where the design is silent:
 * - Setup records are one sequence with `setupDiverged = false`, so setup
 *   records after the first setup `port-bug` are expected to be tainted.
 * - A fuzz record before any `idx == 0` start (idx > 0 first) belongs to an
 *   implicit sequence of its own; it is checked like any other sequence.
 * - Setup records interleaved after fuzz records still belong to the setup group.
 * - Record position in messages is `ordinal` when it is present, otherwise the
 *   1-based position in the input; both are reported as "record N".
 */
export function verifyTaint(records: readonly (OrderedRecord | RecordLine)[]): Result<void, SeanceError> {
  const expected: boolean[] = new Array<boolean>(records.length).fill(false);

  // Group stream positions.
  const setupPos: number[] = [];
  const sequences: number[][] = [];
  records.forEach((r, pos) => {
    if (r.idx === -1) {
      setupPos.push(pos);
      return;
    }
    if (r.idx === 0 || sequences.length === 0) sequences.push([]);
    sequences[sequences.length - 1]!.push(pos);
  });

  const setupFlags = computeTaint(
    setupPos.map((p) => records[p]!),
    false,
  );
  setupPos.forEach((p, i) => {
    expected[p] = setupFlags[i]!;
  });
  const setupDiverged = setupPos.some((p) => records[p]!.classification === "port-bug");

  for (const seq of sequences) {
    const flags = computeTaint(
      seq.map((p) => records[p]!),
      setupDiverged,
    );
    seq.forEach((p, i) => {
      expected[p] = flags[i]!;
    });
  }

  for (let pos = 0; pos < records.length; pos++) {
    const r = records[pos]!;
    if (r.afterDivergence !== expected[pos]) {
      const ordinal = "ordinal" in r && typeof r.ordinal === "number" ? r.ordinal : pos + 1;
      return err(
        seanceError(
          "SEANCE_FAILED",
          `divergence taint mismatch at record ${ordinal} (idx ${r.idx}): handler wrote afterDivergence=${String(r.afterDivergence)}, engine computed ${String(expected[pos])}`,
          { ordinal, idx: r.idx, recorded: r.afterDivergence, recomputed: expected[pos] },
        ),
      );
    }
  }
  return ok(undefined);
}
