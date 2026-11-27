/**
 * Test helper (task 15.1): the Planted_Port_Bug.
 *
 * `plantAllowanceBug` edits the text of the golden BEC port so that `transferFrom` no longer decrements the
 * allowance. Nothing else changes. The golden file on disk is never touched.
 */

/** The one statement removed: `transferFrom`'s allowance decrement in StandardToken. */
export const ALLOWANCE_DECREMENT = "allowed[_from][msg.sender] = allowed[_from][msg.sender] - _value;";

/** Deletes `ALLOWANCE_DECREMENT` (and the whole line it sits on). Throws unless it occurs exactly once. */
export function plantAllowanceBug(portSource: string): string {
  const line = new RegExp(`^[ \\t]*${ALLOWANCE_DECREMENT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\r?\\n`, "gm");
  const total = portSource.split(ALLOWANCE_DECREMENT).length - 1;
  const matches = portSource.match(line)?.length ?? 0;
  if (total !== 1 || matches !== 1) {
    throw new Error(
      `plantAllowanceBug: expected exactly one allowance decrement statement, found ${total} occurrence(s) (${matches} on a line of its own)`,
    );
  }
  return portSource.replace(line, "");
}
