// Turns local stay dates into the absolute instants and refund curve the contract would see.
// Mirrors spec 4.3 and 5.1 closely enough for fixtures; C5 owns the real materialisation.

import { DateTime } from "luxon";
import { BPS_DENOMINATOR, ceilDiv } from "@chain/shared";
import { MAX_NIGHTS, PROPERTY, YIELD } from "./fixtures.js";

export type Cutoff = { cutoffUtc: number; refundBps: number; local: DateTime };

export type Stay = {
  checkIn: string;
  checkOut: string;
  checkInLocal: DateTime;
  checkOutLocal: DateTime;
  checkInUtc: number;
  checkOutUtc: number;
  nights: number;
  priceAtomic: bigint;
  cutoffs: Cutoff[];
  finalBps: number;
};

export class InvalidStay extends Error {}

function localAt(date: string, hour: number): DateTime {
  const dt = DateTime.fromISO(date, { zone: PROPERTY.tz }).set({ hour, minute: 0, second: 0, millisecond: 0 });
  if (!dt.isValid) throw new InvalidStay(`invalid date ${date}`);
  return dt;
}

/** Validates like deposit guards 6, 7 and 11 (spec 4.2), using `now` for "in the future". */
export function materialiseStay(checkIn: string, checkOut: string, now: Date): Stay {
  const checkInLocal = localAt(checkIn, PROPERTY.checkInHour);
  const checkOutLocal = localAt(checkOut, PROPERTY.checkOutHour);
  const checkInUtc = checkInLocal.toUnixInteger();
  const checkOutUtc = checkOutLocal.toUnixInteger();
  const nowUtc = Math.floor(now.getTime() / 1000);

  if (!(nowUtc < checkInUtc && checkInUtc < checkOutUtc)) {
    throw new InvalidStay("check-in must be in the future and before check-out");
  }
  const nights = Number(ceilDiv(BigInt(checkOutUtc - checkInUtc), 86_400n));
  if (nights < 1 || nights > MAX_NIGHTS) throw new InvalidStay(`nights must be 1..${MAX_NIGHTS}`);

  const cutoffs = PROPERTY.cutoffRules.map((r) => {
    const local = localAt(checkIn, r.hour).minus({ days: r.daysBefore });
    return { cutoffUtc: local.toUnixInteger(), refundBps: r.refundBps, local };
  });
  assertCurve(cutoffs, PROPERTY.finalBps, checkInUtc);

  return {
    checkIn,
    checkOut,
    checkInLocal,
    checkOutLocal,
    checkInUtc,
    checkOutUtc,
    nights,
    priceAtomic: PROPERTY.nightlyAtomic * BigInt(nights),
    cutoffs,
    finalBps: PROPERTY.finalBps,
  };
}

/** Guard 11. */
function assertCurve(cutoffs: Cutoff[], finalBps: number, checkInUtc: number): void {
  if (cutoffs.length < 1 || cutoffs.length > 8) throw new InvalidStay("1..8 cutoffs");
  cutoffs.forEach((c, i) => {
    const prev = cutoffs[i - 1];
    if (c.refundBps > 10_000 || c.cutoffUtc >= checkInUtc) throw new InvalidStay("bad cutoff");
    if (prev && (c.cutoffUtc <= prev.cutoffUtc || c.refundBps > prev.refundBps)) {
      throw new InvalidStay("curve not monotonic");
    }
  });
  const last = cutoffs[cutoffs.length - 1];
  if (last === undefined || finalBps > last.refundBps) throw new InvalidStay("finalBps above last cutoff");
}

/** Spec 4.3. Returns null when not cancellable (now >= checkOut). */
export function refundBpsAt(stay: Stay, now: Date): number | null {
  const t = Math.floor(now.getTime() / 1000);
  if (t >= stay.checkOutUtc) return null;
  if (t >= stay.checkInUtc) return stay.finalBps;
  for (const c of stay.cutoffs) if (t < c.cutoffUtc) return c.refundBps;
  return stay.finalBps;
}

/** Refund curve for display: each cutoff, then `finalBps` until check-out. */
export function refundCurve(stay: Stay): { untilLocal: string; refundBps: number }[] {
  return [
    ...stay.cutoffs.map((c) => ({ untilLocal: isoLocal(c.local), refundBps: c.refundBps })),
    { untilLocal: isoLocal(stay.checkOutLocal), refundBps: stay.finalBps },
  ];
}

export function isoLocal(dt: DateTime): string {
  return dt.toISO({ suppressMilliseconds: true, includeOffset: true }) as string;
}

export function isoUtc(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(".000Z", "Z");
}

/**
 * Spec 8: deployment window is (checkIn - 14 days) - now, at most 90% deployed, split by
 * guestYieldBps. Every step rounds down. Always an estimate.
 */
export function estimateGuestYield(stay: Stay, now: Date, apyBps: number, guestYieldBps: number): bigint {
  const nowUtc = BigInt(Math.floor(now.getTime() / 1000));
  const window = BigInt(stay.checkInUtc) - YIELD.minLeadTimeSeconds - nowUtc;
  if (window <= 0n) return 0n;
  const year = 365n * 86_400n;
  const gross =
    (stay.priceAtomic * BigInt(apyBps) * window * YIELD.maxDeployBps) / (BPS_DENOMINATOR * year * BPS_DENOMINATOR);
  return (gross * BigInt(guestYieldBps)) / BPS_DENOMINATOR;
}
