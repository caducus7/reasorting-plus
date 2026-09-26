// Reference evaluator for the escrow's refund curve and settlement maths (chain-spec.md 4.2 guard 11,
// 4.3, 4.4). Used by the quote service (refund if cancelled now, cancel preview) and the indexer.
// It must match the contract exactly: the quote service's differential test runs both on Anvil.
// All money is bigint atomic units; bps are integers 0..10000.

export const BPS = 10_000n;
export const ACC_SCALE = 10n ** 18n;
export const MAX_CUTOFFS = 8;

export type Cutoff = { cutoffUtc: number; refundBps: number };

export type CurveTerms = {
  checkInUtc: number;
  checkOutUtc: number;
  cutoffs: readonly Cutoff[];
  finalBps: number;
};

export type Figures = {
  refund: bigint;
  ownerPrincipal: bigint;
  fee: bigint;
  guestYield: bigint;
  ownerYield: bigint;
};

function assertBps(v: number, name: string): void {
  if (!Number.isInteger(v) || v < 0 || v > 10_000) throw new RangeError(`${name} out of range: ${v}`);
}

/** Deposit guard 11: 1..8 cutoffs, strictly increasing, all before check-in, refund non-increasing
 * and <= 100%, finalBps no higher than the last cutoff. */
export function validCurve(cutoffs: readonly Cutoff[], finalBps: number, checkInUtc: number): boolean {
  const n = cutoffs.length;
  if (n === 0 || n > MAX_CUTOFFS) return false;
  for (let i = 0; i < n; i++) {
    const c = cutoffs[i]!;
    if (c.refundBps > 10_000 || c.refundBps < 0 || c.cutoffUtc >= checkInUtc) return false;
    const prev = cutoffs[i - 1];
    if (prev && (c.cutoffUtc <= prev.cutoffUtc || c.refundBps > prev.refundBps)) return false;
  }
  return finalBps >= 0 && finalBps <= cutoffs[n - 1]!.refundBps;
}

/** Spec 4.3: refund bps for a guest cancellation at `nowUtc`; null when not cancellable
 * (now >= checkOut). Cutoffs are strict: at the cutoff second the next tier applies. */
export function refundBpsAt(t: CurveTerms, nowUtc: number): number | null {
  if (nowUtc >= t.checkOutUtc) return null;
  if (nowUtc >= t.checkInUtc) return t.finalBps;
  for (const c of t.cutoffs) if (nowUtc < c.cutoffUtc) return c.refundBps;
  return t.finalBps;
}

/** Guest refund, rounded up (money rule 1). */
export function refundOf(principal: bigint, refundBps: number): bigint {
  assertBps(refundBps, "refundBps");
  const num = principal * BigInt(refundBps);
  return num === 0n ? 0n : (num - 1n) / BPS + 1n;
}

/** Spec 4.4 settlement figures. Fee on what the owner retains (D1), never on yield (D2);
 * guest yield only when vested, otherwise to the owner (D3). */
export function settlementFigures(
  principal: bigint,
  refundBps: number,
  feeBps: number,
  y: bigint,
  guestYieldBps: number,
  vested: boolean,
): Figures {
  assertBps(feeBps, "feeBps");
  assertBps(guestYieldBps, "guestYieldBps");
  if (principal < 0n || y < 0n) throw new RangeError("negative amount");
  const refund = refundOf(principal, refundBps);
  const retained = principal - refund;
  const fee = (retained * BigInt(feeBps)) / BPS;
  const guestYield = vested ? (y * BigInt(guestYieldBps)) / BPS : 0n;
  return { refund, ownerPrincipal: retained - fee, fee, guestYield, ownerYield: y - guestYield };
}

/** Spec 6.1: a booking's realised yield from the accumulator, rounded down. */
export function bookingYield(principal: bigint, accNow: bigint, accAtDeposit: bigint): bigint {
  return (principal * (accNow - accAtDeposit)) / ACC_SCALE;
}
