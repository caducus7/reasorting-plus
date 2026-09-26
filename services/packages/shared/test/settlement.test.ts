import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { bookingYield, refundBpsAt, settlementFigures, validCurve } from "../src/settlement.js";

const terms = {
  checkInUtc: 1_000_000,
  checkOutUtc: 1_600_000,
  cutoffs: [
    { cutoffUtc: 100_000, refundBps: 10_000 },
    { cutoffUtc: 500_000, refundBps: 5_000 },
    { cutoffUtc: 800_000, refundBps: 2_500 },
  ],
  finalBps: 0,
};

describe("refundBpsAt (spec 4.3)", () => {
  it.each([
    [99_999, 10_000],
    [100_000, 5_000], // strict: at the cutoff second the next tier applies
    [799_999, 2_500],
    [800_000, 0],
    [1_000_000, 0], // check-in: finalBps
    [1_599_999, 0],
  ])("at %i -> %i", (t, bps) => expect(refundBpsAt(terms, t)).toBe(bps));

  it("is not cancellable at check-out", () => {
    expect(refundBpsAt(terms, 1_600_000)).toBeNull();
  });
});

describe("validCurve (guard 11)", () => {
  it("accepts the default curve", () => expect(validCurve(terms.cutoffs, 0, terms.checkInUtc)).toBe(true));
  it.each([
    ["empty", [], 0],
    ["nine", Array.from({ length: 9 }, (_, i) => ({ cutoffUtc: i + 1, refundBps: 10_000 })), 0],
    ["not increasing", [{ cutoffUtc: 5, refundBps: 10_000 }, { cutoffUtc: 5, refundBps: 5_000 }], 0],
    ["refund rises", [{ cutoffUtc: 5, refundBps: 5_000 }, { cutoffUtc: 6, refundBps: 6_000 }], 0],
    ["over 100%", [{ cutoffUtc: 5, refundBps: 10_001 }], 0],
    ["at check-in", [{ cutoffUtc: 1_000_000, refundBps: 10_000 }], 0],
    ["final above last", [{ cutoffUtc: 5, refundBps: 5_000 }], 5_001],
  ])("rejects %s", (_n, cutoffs, finalBps) => {
    expect(validCurve(cutoffs, finalBps as number, 1_000_000)).toBe(false);
  });
});

describe("settlementFigures (spec 4.4)", () => {
  it("known values: 5,600 USDC, 50% refund, 5% fee", () => {
    const f = settlementFigures(5_600_000_000n, 5_000, 500, 0n, 5_000, false);
    expect(f).toEqual({ refund: 2_800_000_000n, ownerPrincipal: 2_660_000_000n, fee: 140_000_000n, guestYield: 0n, ownerYield: 0n });
  });

  it("refund rounds up, fee and guest yield round down", () => {
    expect(settlementFigures(3n, 3_333, 0, 0n, 0, false).refund).toBe(1n);
    const f = settlementFigures(999n, 0, 333, 7n, 5_000, true);
    expect(f.fee).toBe(33n); // 999 * 3.33% = 33.26 -> 33
    expect(f.guestYield).toBe(3n); // 3.5 -> 3
    expect(f.ownerYield).toBe(4n);
  });

  it("equalities hold for any input (property)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 30n }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 2_000 }),
        fc.bigInt({ min: 0n, max: 10n ** 30n }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.boolean(),
        (p, rb, fb, y, gy, vested) => {
          const f = settlementFigures(p, rb, fb, y, gy, vested);
          expect(f.refund + f.ownerPrincipal + f.fee).toBe(p);
          expect(f.guestYield + f.ownerYield).toBe(y);
          expect(f.fee <= p - f.refund).toBe(true);
          expect(f.refund * 10_000n >= p * BigInt(rb)).toBe(true);
          if (!vested) expect(f.guestYield).toBe(0n);
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it("rejects out-of-range bps", () => {
    expect(() => settlementFigures(1n, 10_001, 0, 0n, 0, false)).toThrow(RangeError);
    expect(() => settlementFigures(1n, 0, -1, 0n, 0, false)).toThrow(RangeError);
  });
});

describe("bookingYield (spec 6.1)", () => {
  it("rounds down", () => {
    expect(bookingYield(3_333_333_333_333n, 100_000n, 0n)).toBe(0n);
    expect(bookingYield(10_000_000_000_000n, 100_000n, 0n)).toBe(1n);
  });
});
