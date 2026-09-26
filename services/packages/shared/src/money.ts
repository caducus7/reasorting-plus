// Money is bigint of USDC atomic units (6 decimals) end to end, serialised as decimal strings.
// A `number` on a money path is a bug (CLAUDE.md section 3).

export const USDC_DECIMALS = 6;
export const ATOMIC_PER_USDC = 1_000_000n;
export const BPS_DENOMINATOR = 10_000n;

/** Non-negative integer, no leading zeros, no sign, no exponent. */
export const ATOMIC_STRING_RE = /^(0|[1-9][0-9]*)$/;

export function toAtomicString(value: bigint): string {
  if (value < 0n) throw new RangeError(`negative atomic amount: ${value}`);
  return value.toString(10);
}

export function parseAtomic(value: string): bigint {
  if (!ATOMIC_STRING_RE.test(value)) throw new RangeError(`not an atomic amount: ${JSON.stringify(value)}`);
  return BigInt(value);
}

/** Rounds up. Guest refunds use this (CLAUDE.md money rule 1). */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError("ceilDiv by non-positive divisor");
  if (a < 0n) throw new RangeError("ceilDiv of negative dividend");
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

/** Guest refund for a principal at `refundBps`, rounded up (spec 4.4). */
export function refundAtomic(principal: bigint, refundBps: number): bigint {
  return ceilDiv(principal * BigInt(refundBps), BPS_DENOMINATOR);
}
