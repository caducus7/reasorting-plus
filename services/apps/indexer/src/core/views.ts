// Read-side views (brief C6 "Read API used by C5"): pure functions over projection rows, so the
// numbers are unit-testable and identical wherever they are served.
import { bookingYield, refundBpsAt, refundOf } from "@chain/shared";
import { projectedFields } from "./invariants.js";
import { effectiveArbitrator, effectiveFeeBps } from "./reducer.js";
import { A } from "./accounts.js";
import type { BookingRow, EscrowRow } from "./types.js";

const BPS = 10_000n;
export type ApiState = "ESCROWED" | "DELIVERED" | "FROZEN" | "DISPUTED" | "SETTLED";

/** Escrow._bookingNow (docs/adr/0015 §1): chain time minus completed freezes. A freeze in progress
 * is added at unfreeze; nothing on the booking can move while it lasts. */
export function bookingNow(b: BookingRow, chainNow: bigint): bigint {
  return chainNow - b.frozenTotal;
}

/** Escrow.bookingState(): DELIVERED is derived from the booking's clock. */
export function apiState(b: BookingRow, chainNow: bigint): ApiState {
  if (b.status === "ESCROWED" && bookingNow(b, chainNow) >= b.checkOutUtc) return "DELIVERED";
  return b.status;
}

export type Buckets = { guestClaimable: bigint; feeClaimable: bigint; ownerClaimable: bigint; pendingGuestYield: bigint };

export function bucketsOf(balances: Map<string, bigint>, account: string, payout: string | null): Buckets {
  const b = (k: string) => balances.get(k) ?? 0n;
  return {
    guestClaimable: b(A.guestClaimable(account)),
    feeClaimable: b(A.feeClaimable(account)),
    ownerClaimable: payout && payout.toLowerCase() === account.toLowerCase() ? b(A.ownerClaimable) : 0n,
    pendingGuestYield: b(A.pendingGuest(account)),
  };
}

export function bookingView(b: BookingRow, e: EscrowRow, chainNow: bigint, buckets: Buckets) {
  const state = apiState(b, chainNow);
  const now = bookingNow(b, chainNow);
  const terms = { checkInUtc: Number(b.checkInUtc), checkOutUtc: Number(b.checkOutUtc), cutoffs: b.cutoffs, finalBps: b.finalBps };
  const refundBps = b.status === "ESCROWED" ? refundBpsAt(terms, Number(now)) : null;
  const gy = BigInt(b.guestYieldBps);
  const accrued =
    b.status === "SETTLED"
      ? b.guestYield
      : b.status === "DISPUTED"
        ? (b.disputeYield * gy) / BPS
        : (bookingYield(b.principalAtomic, e.accYieldPerUnit, b.accAtDeposit) * gy) / BPS;
  return {
    escrow: b.escrow,
    bookingId: b.bookingId,
    state,
    outcome: b.outcome,
    guest: b.guest,
    resourceId: b.resourceId,
    checkInUtc: Number(b.checkInUtc),
    checkOutUtc: Number(b.checkOutUtc),
    principalAtomic: b.principalAtomic,
    feeBps: b.feeBps,
    guestYieldBps: b.guestYieldBps,
    finalBps: b.finalBps,
    cutoffs: b.cutoffs,
    frozenTotal: Number(b.frozenTotal),
    /** Refund if the guest cancelled now (C5's reference evaluator, @chain/shared); null if not cancellable. */
    refundBps,
    refundIfCancelledNowAtomic: refundBps === null ? null : refundOf(b.principalAtomic, refundBps),
    /** Guest's yield share: realised to the last accrual while open (an estimate of what vests),
     * the credited figure once settled. */
    accruedGuestYieldAtomic: accrued,
    yieldDeferred: b.yieldDeferred,
    claimableAtomic: buckets.guestClaimable + buckets.feeClaimable + buckets.ownerClaimable,
    pendingYieldAtomic: buckets.pendingGuestYield,
    settlement:
      b.status === "SETTLED"
        ? { refund: b.refund, ownerPrincipal: b.ownerPrincipal, fee: b.fee, y: b.y, guestYield: b.guestYield, ownerYield: b.ownerYield }
        : null,
    txHash: b.depositTx,
    depositBlock: b.depositBlock,
  };
}

/** Owner digest: configuration as effective now, the ledger's totals and bookings by state. */
export function escrowSummary(e: EscrowRow, balances: Map<string, bigint>, bookings: BookingRow[], chainNow: bigint) {
  const f = projectedFields(balances, e);
  const byState: Record<string, number> = {};
  for (const b of bookings) byState[apiState(b, chainNow)] = (byState[apiState(b, chainNow)] ?? 0) + 1;
  return {
    escrow: e.id,
    owner: e.owner,
    payoutAddress: e.payoutAddress,
    vault: e.vault,
    vaultWrittenOff: e.vaultWrittenOff,
    paused: e.paused,
    effectiveFeeBps: effectiveFeeBps(e, chainNow),
    pendingFee: e.pendingFeeAt !== 0n && chainNow < e.pendingFeeAt ? { feeBps: e.pendingFeeBps, effectiveAt: Number(e.pendingFeeAt) } : null,
    effectiveArbitrator: effectiveArbitrator(e, chainNow),
    guestYieldBps: e.guestYieldBps,
    ledger: {
      ...f,
      idle: balances.get(A.idle) ?? 0n,
      deployed: balances.get(A.deployed) ?? 0n,
      liabilities: f.totalOpenPrincipal + f.totalDisputed + f.totalPendingYield + f.totalClaimable,
      lossActive: f.lossDebt !== 0n || f.shortfallSince !== 0n,
    },
    bookings: byState,
  };
}

/** JSON with money as decimal strings (CLAUDE.md §3). */
export const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
