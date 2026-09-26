// Deterministic fixtures for the pilot villa. Everything here is fake and labelled as such.

import { keccak256, stringToHex, type Address, type Hex } from "viem";
import { ATOMIC_PER_USDC } from "@chain/shared";

export const PROPERTY = {
  resourceId: keccak256(stringToHex("stub:villa:crete:1")),
  name: "Stub Villa (Crete)",
  tz: "Europe/Athens",
  maxGuests: 8,
  nightlyAtomic: 800n * ATOMIC_PER_USDC,
  checkInHour: 15,
  checkOutHour: 11,
  policyId: "pol_stub_standard_v1",
  /** Three cutoffs, each at 18:00 local, N days before arrival. Earliest first. */
  cutoffRules: [
    { daysBefore: 30, hour: 18, refundBps: 10_000 },
    { daysBefore: 14, hour: 18, refundBps: 5_000 },
    { daysBefore: 7, hour: 18, refundBps: 2_500 },
  ],
  /** Refund from the last cutoff until check-out, including no-shows (spec 4.3). */
  finalBps: 0,
  /** Only ever inside `quote` in the prepare response (spec 5.3). */
  feeBps: 500,
  guestYieldBps: 5_000,
} as const;

export const RENDERED_POLICY =
  "Full refund if you cancel before 18:00 (Europe/Athens) 30 days before arrival. " +
  "50% refund until 18:00 14 days before arrival. 25% refund until 18:00 7 days before arrival. " +
  "No refund after that, including no-shows and early departures. " +
  "If the property cancels, you receive a full refund.";

export const POLICY_HASH: Hex = keccak256(stringToHex(RENDERED_POLICY));

/** Clearly fake: repeating-digit addresses. Calls carrying them are flagged `stub: true`. */
export const STUB_USDC: Address = "0x1111111111111111111111111111111111111111";
export const STUB_ESCROW: Address = "0x2222222222222222222222222222222222222222";

/** Fake 65-byte signature: r and s of 0x5b bytes, v = 27. Recognisable, never valid. */
export const STUB_QUOTE_SIG: Hex = `0x${"5b".repeat(64)}1b`;

export const YIELD = {
  /** Aave V3 Base USDC supply APY in the spec 6.7 snapshot. Fixture only. */
  apyEstimateBps: 418,
  protocol: "Aave V3 on Base (stub)",
  vestingRule: "completed_stay_no_refund",
  /** Principal must be liquid from this long before check-in (spec 6.7, 8). */
  minLeadTimeSeconds: 14n * 86_400n,
  /** At most this share is deployed (spec 6.3, 8). */
  maxDeployBps: 9_000n,
} as const;

/** Offer price lock (spec 5.2, 13). */
export const OFFER_LOCK_SECONDS = 25 * 60;
/** Prepared-quote lifetime. Not fixed by the spec; the stub's choice. */
export const QUOTE_TTL_SECONDS = 15 * 60;
/** Spec 13. */
export const MAX_NIGHTS = 60;

/**
 * The single booking every bookingId resolves to. A 7-night July 2027 stay, so it is ESCROWED and
 * fully refundable for a long time, and the default fixture is stable.
 */
export const BOOKING = {
  checkIn: "2027-07-10",
  checkOut: "2027-07-17",
  /** Default scenario: guest's share of yield accrued so far (4.21 USDC). */
  accruedGuestYieldAtomic: 4_210_000n,
  /** `settled` scenario: vested guest share credited at settlement (11.87 USDC). */
  settledGuestYieldAtomic: 11_870_000n,
  /** `cancelled` scenario: the guest cancelled while the 50% cutoff applied. */
  cancelledRefundBps: 5_000,
} as const;
