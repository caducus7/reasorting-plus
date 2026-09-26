import { describe, expect, it } from "vitest";
import { ceilDiv, parseAtomic, refundAtomic, toAtomicString } from "../src/money.js";

describe("money", () => {
  it("round-trips atomic strings beyond 2^53", () => {
    const big = 2n ** 80n + 7n;
    expect(parseAtomic(toAtomicString(big))).toBe(big);
  });

  it.each(["", "-1", "01", "1.5", "1e6", " 1", "0x10"])("rejects %j", (s) => {
    expect(() => parseAtomic(s)).toThrow(RangeError);
  });

  it("rejects negative amounts", () => {
    expect(() => toAtomicString(-1n)).toThrow(RangeError);
  });

  it("ceilDiv rounds up and is exact on multiples", () => {
    expect(ceilDiv(0n, 3n)).toBe(0n);
    expect(ceilDiv(9n, 3n)).toBe(3n);
    expect(ceilDiv(10n, 3n)).toBe(4n);
  });

  it("guest refund rounds up", () => {
    // 1 atomic unit at 50% -> 1, not 0
    expect(refundAtomic(1n, 5_000)).toBe(1n);
    expect(refundAtomic(5_600_000_000n, 5_000)).toBe(2_800_000_000n);
    expect(refundAtomic(3n, 3_333)).toBe(1n);
  });
});
