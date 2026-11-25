import fc from "fast-check";
import { describe, expect, it } from "vitest";

describe("toolchain smoke", () => {
  it("runs a fast-check property under vitest", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        expect(a + b).toBe(b + a);
      }),
    );
  });
});
