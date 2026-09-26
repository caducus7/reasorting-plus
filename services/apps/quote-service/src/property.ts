// Property and cancellation-policy configuration, and its materialisation into on-chain terms
// (chain-spec.md 5.1). Owners write policies in local terms; the contract only ever sees UTC
// instants (it knows nothing about time zones or DST).

import { DateTime } from "luxon";
import { z } from "zod";
import { validCurve, type Cutoff } from "@chain/shared";

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
// Canonical lowercase: resource_id keys the holds and the calendar tables shared with C6/C7.
const Bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((s) => s.toLowerCase() as `0x${string}`);

/** One policy rule: `refundBps` if the guest cancels before `time` local, `daysBefore` days before
 * the check-in date. */
export const PolicyRule = z.strictObject({
  daysBefore: z.number().int().min(0).max(730),
  time: HHMM,
  refundBps: z.number().int().min(0).max(10_000),
});

export const Policy = z.strictObject({
  id: z.string().min(1).max(128),
  rendered: z.string().min(1),
  rules: z.array(PolicyRule).min(1).max(8), // earliest (largest daysBefore) first
  finalBps: z.number().int().min(0).max(10_000),
});

export const Property = z.strictObject({
  resourceId: Bytes32,
  name: z.string().min(1),
  tz: z.string().min(1),
  maxGuests: z.number().int().min(1),
  checkInTime: HHMM,
  checkOutTime: HHMM,
  nightlyAtomic: z.string().regex(/^[1-9][0-9]*$/),
  minNights: z.number().int().min(1).default(1),
  maxNights: z.number().int().min(1).max(60).default(60), // spec 13 MAX_NIGHTS
  policy: Policy,
});
export type Property = z.infer<typeof Property>;
export type Policy = z.infer<typeof Policy>;

export class InvalidStay extends Error {}
export class InvalidPolicy extends Error {}

function hm(t: string): { hour: number; minute: number } {
  const [h, m] = t.split(":");
  return { hour: Number(h), minute: Number(m) };
}

/**
 * The UTC instant of a local wall-clock time in `tz`, with an explicit DST rule (docs/adr/0012):
 * - wall time inside a spring-forward gap (does not exist): the first instant after the gap, which
 *   is what the wall clock reads when it jumps (e.g. 03:30 -> 04:30 EEST on the Athens change day);
 * - wall time inside a fall-back overlap (occurs twice): the LATER instant, which gives the guest
 *   the longer window at the better refund tier (guest-favourable, as refunds round up).
 */
export function localInstant(date: string, time: string, tz: string): DateTime {
  const { hour, minute } = hm(time);
  const d = DateTime.fromISO(date, { zone: tz });
  if (!d.isValid) throw new InvalidStay(`invalid date ${date} in ${tz}`);
  const wall = { year: d.year, month: d.month, day: d.day, hour, minute, second: 0, millisecond: 0 };
  const guess = DateTime.fromObject(wall, { zone: tz });
  const later = guess.plus({ hours: 1 });
  const sameWall = (x: DateTime) =>
    x.year === wall.year && x.month === wall.month && x.day === wall.day && x.hour === hour && x.minute === minute;
  if (sameWall(guess) && sameWall(later)) return later; // overlap: take the later occurrence
  const earlier = guess.minus({ hours: 1 });
  if (sameWall(guess) && sameWall(earlier)) return guess; // guess already the later occurrence
  return guess; // exists once, or Luxon has moved it forward out of a gap
}

export type MaterialisedCutoff = Cutoff & { local: DateTime };

export type Stay = {
  checkIn: string;
  checkOut: string;
  checkInLocal: DateTime;
  checkOutLocal: DateTime;
  checkInUtc: number;
  checkOutUtc: number;
  nights: number;
  priceAtomic: bigint;
  cutoffs: MaterialisedCutoff[];
  finalBps: number;
};

/** Validates a stay like deposit guards 6, 7 and 11 (spec 4.2) and materialises the policy.
 * `nowUtc` is the chain time the check is made against. */
export function materialiseStay(p: Property, checkIn: string, checkOut: string, nowUtc: number): Stay {
  const checkInLocal = localInstant(checkIn, p.checkInTime, p.tz);
  const checkOutLocal = localInstant(checkOut, p.checkOutTime, p.tz);
  const checkInUtc = checkInLocal.toUnixInteger();
  const checkOutUtc = checkOutLocal.toUnixInteger();
  if (!(nowUtc < checkInUtc && checkInUtc < checkOutUtc)) {
    throw new InvalidStay("check-in must be in the future and before check-out");
  }
  // Same rounding as the contract: nights = ceil((checkOut - checkIn) / 1 day).
  const nights = Math.ceil((checkOutUtc - checkInUtc) / 86_400);
  if (nights < p.minNights || nights > p.maxNights) {
    throw new InvalidStay(`nights must be ${p.minNights}..${p.maxNights}`);
  }
  const cutoffs = p.policy.rules.map((r) => {
    const date = DateTime.fromISO(checkIn, { zone: p.tz }).minus({ days: r.daysBefore }).toISODate() as string;
    const local = localInstant(date, r.time, p.tz);
    return { cutoffUtc: local.toUnixInteger(), refundBps: r.refundBps, local };
  });
  if (!validCurve(cutoffs, p.policy.finalBps, checkInUtc)) {
    throw new InvalidPolicy(`policy ${p.policy.id} does not produce a valid curve for ${checkIn}`);
  }
  return {
    checkIn,
    checkOut,
    checkInLocal,
    checkOutLocal,
    checkInUtc,
    checkOutUtc,
    nights,
    priceAtomic: BigInt(p.nightlyAtomic) * BigInt(nights),
    cutoffs,
    finalBps: p.policy.finalBps,
  };
}

export function isoLocal(dt: DateTime): string {
  return dt.toISO({ suppressMilliseconds: true, includeOffset: true }) as string;
}

export function isoUtc(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(".000Z", "Z");
}

/** Refund curve for display: each cutoff, then finalBps until check-out (docs/adr/0001). */
export function refundCurve(stay: Stay): { untilLocal: string; refundBps: number }[] {
  return [
    ...stay.cutoffs.map((c) => ({ untilLocal: isoLocal(c.local), refundBps: c.refundBps })),
    { untilLocal: isoLocal(stay.checkOutLocal), refundBps: stay.finalBps },
  ];
}
