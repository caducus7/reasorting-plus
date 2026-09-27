// Ledger and booking projections, rebuilt purely from escrow and factory events (spec 4.7, 10.3).
// Each handler mirrors one code path of LedgerLib / DisputeLib / Escrow posting by posting, so the
// projection's totals equal the contract's own accounting fields after every event (brief test 3).
// No chain reads: everything comes from event data plus projection state built from earlier events.

import { getAddress, type Address, type Hex } from "viem";
import { A, cr, dr, type Leg } from "./accounts.js";
import {
  eventKey,
  OUTCOMES,
  STORED_STATES,
  type Anomaly,
  type BookingRow,
  type BookingStatus,
  type ChainEvent,
  type EscrowRow,
  type ReduceResult,
  type Store,
} from "./types.js";

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const big = (v: unknown) => BigInt(v as bigint | number);
const num = (v: unknown) => Number(v as number | bigint);
const addr = (v: unknown) => getAddress(v as string);

/** Events that change nothing the projections hold. */
const IGNORED = new Set(["Initialized", "EIP712DomainChanged"]);

export function newEscrowRow(chainId: number, escrow: Address): EscrowRow {
  return {
    id: escrow,
    chainId,
    owner: null,
    vault: null,
    vaultWrittenOff: false,
    paused: false,
    maxFeeBps: 0,
    feeBps: 0,
    pendingFeeBps: 0,
    pendingFeeAt: 0n,
    guestYieldBps: 0,
    arbitrator: null,
    pendingArbitrator: null,
    pendingArbitratorAt: 0n,
    payoutAddress: null,
    quoteSigner: null,
    rebalancer: null,
    maxDeployBps: 0,
    maxOpenPrincipalAtomic: 0n,
    minNightlyAtomic: 0n,
    pendingReserveWithdrawal: 0n,
    accYieldPerUnit: 0n,
    shortfallSince: 0n,
    realisedGain: 0n,
    crystallisedYield: 0n,
    lastDeferred: null,
  };
}

/** Creates the escrow row. Factory `EscrowCreated` does this in production; tests call it directly. */
export async function bootstrapEscrow(
  store: Store,
  p: { chainId: number; escrow: Address; vault: Address | null; owner?: Address; maxFeeBps?: number; feeBps?: number; arbitrator?: Address },
) {
  const escrow = getAddress(p.escrow);
  if (await store.getEscrow(escrow)) return;
  const row = newEscrowRow(p.chainId, escrow);
  row.vault = p.vault && p.vault !== "0x0000000000000000000000000000000000000000" ? getAddress(p.vault) : null;
  row.owner = p.owner ?? null;
  row.maxFeeBps = p.maxFeeBps ?? 0;
  row.feeBps = p.feeBps ?? 0;
  row.arbitrator = p.arbitrator ?? null;
  await store.putEscrow(row);
}

/** Effective fee at time `t` (spec 3.4): a pure function of the proposal and time. */
export function effectiveFeeBps(e: EscrowRow, t: bigint): number {
  return e.pendingFeeAt !== 0n && t >= e.pendingFeeAt ? e.pendingFeeBps : e.feeBps;
}

export function effectiveArbitrator(e: EscrowRow, t: bigint): Address | null {
  return e.pendingArbitratorAt !== 0n && t >= e.pendingArbitratorAt ? e.pendingArbitrator : e.arbitrator;
}

/** Contract's lossActive(): lossDebt or an observed shortfall (ADR 0009, 0015 §4). */
async function lossActive(store: Store, e: EscrowRow) {
  return (await store.balance(e.id, A.lossDebt)) !== 0n || e.shortfallSince !== 0n;
}

/** Applies one log. Idempotent on (chainId, txHash, logIndex). */
export async function reduce(store: Store, ev: ChainEvent): Promise<ReduceResult> {
  const key = eventKey(ev);
  if (await store.seen(key)) return { duplicate: true, legs: [], anomalies: [] };
  const anomalies: Anomaly[] = [];
  const legs: Leg[] = [];

  if (ev.name === "EscrowCreated") {
    const a = ev.args;
    await bootstrapEscrow(store, {
      chainId: ev.chainId,
      escrow: addr(a.escrow),
      vault: addr(a.vault),
      owner: addr(a.owner),
      maxFeeBps: num(a.maxFeeBps),
      feeBps: num(a.feeBps),
      arbitrator: addr(a.arbitrator),
    });
    await store.markSeen(key, ev);
    return { duplicate: false, legs, anomalies };
  }

  const escrow = getAddress(ev.address);
  const e = await store.getEscrow(escrow);
  const flag = (code: string, message: string) => anomalies.push({ code, message, eventKey: key, escrow });
  if (!e) {
    flag("UNKNOWN_ESCROW", `${ev.name} from an escrow the factory never announced`);
    await store.markSeen(key, ev);
    return { duplicate: false, legs, anomalies };
  }
  const args = ev.args;
  const push = (...ls: Leg[]) => legs.push(...ls.filter((l) => l.amount !== 0n));
  const bal = (acct: string) => store.balance(escrow, acct);
  // Valuation changes land on the vault position; with no vault only idle can move.
  const valuation = e.vault ? A.deployed : A.idle;

  const booking = async (id: unknown): Promise<BookingRow | undefined> => {
    const b = await store.getBooking(escrow, id as Hex);
    if (!b) flag("UNKNOWN_BOOKING", `${ev.name} for unknown booking ${String(id)}`);
    return b;
  };
  const deferredHere = (id: Hex) => e.lastDeferred === `${ev.txHash.toLowerCase()}:${id.toLowerCase()}`;
  let bookingOut: BookingRow | undefined;

  switch (ev.name) {
    // ------------------------------------------------------------------ bookings (spec 4.2 to 4.6)
    case "BookingDeposited": {
      const id = (args.bookingId as Hex).toLowerCase() as Hex;
      const p = big(args.principalAtomic);
      push(dr(A.idle, p), cr(A.openPrincipal, p));
      bookingOut = {
        id: `${escrow.toLowerCase()}:${id}`,
        escrow,
        bookingId: id,
        guest: addr(args.guest),
        resourceId: (args.resourceId as Hex).toLowerCase() as Hex,
        checkInUtc: big(args.checkInUtc),
        checkOutUtc: big(args.checkOutUtc),
        principalAtomic: p,
        feeBps: num(args.feeBps),
        guestYieldBps: num(args.guestYieldBps),
        policyHash: args.policyHash as Hex,
        cutoffs: (args.cutoffs as { cutoffUtc: number; refundBps: number }[]).map((c) => ({
          cutoffUtc: num(c.cutoffUtc),
          refundBps: num(c.refundBps),
        })),
        finalBps: num(args.finalBps),
        arbitrator: addr(args.arbitrator),
        accAtDeposit: big(args.accAtDeposit),
        status: "ESCROWED",
        frozenFrom: null,
        frozenSince: 0n,
        frozenTotal: 0n,
        outcome: null,
        refundBps: null,
        contestedAtomic: 0n,
        disputeYield: 0n,
        disputeOpenedAt: 0n,
        refund: 0n,
        ownerPrincipal: 0n,
        fee: 0n,
        y: 0n,
        guestYield: 0n,
        ownerYield: 0n,
        yieldDeferred: false,
        depositBlock: ev.blockNumber,
        depositBlockHash: ev.blockHash,
        depositTx: ev.txHash,
        depositTimestamp: ev.timestamp,
        settledBlock: null,
        settledTimestamp: null,
      };
      if (await store.getBooking(escrow, id)) flag("DUPLICATE_BOOKING", `booking ${id} deposited twice`);
      break;
    }
    case "BookingSettled": {
      const b = await booking(args.bookingId);
      if (!b) break;
      const [p, refund, op, fee, y, gy, oy] = [
        big(args.principalAtomic), big(args.refund), big(args.ownerPrincipal), big(args.fee),
        big(args.y), big(args.guestYield), big(args.ownerYield),
      ];
      const feeTo = addr(args.feeRecipient);
      if (refund + op + fee !== p) flag("INV-6", `refund + ownerPrin + fee != principal on ${b.bookingId}`);
      if (gy + oy !== y) flag("INV-6", `guestY + ownerY != y on ${b.bookingId}`);
      if (p !== b.principalAtomic) flag("INV-6", `settled principal ${p} != deposited ${b.principalAtomic}`);
      if (b.status !== "ESCROWED") flag("STATE", `settled from ${b.status}`);
      const active = await lossActive(store, e);
      if (active !== deferredHere(b.bookingId)) flag("DIVERGENCE", `yield deferral mismatch on ${b.bookingId}`);
      push(dr(A.openPrincipal, p), dr(A.yieldUnallocated, y), cr(A.feeClaimable(feeTo), fee));
      if (!active) {
        push(cr(A.guestClaimable(b.guest), refund + gy), cr(A.ownerClaimable, op + oy));
      } else {
        push(cr(A.guestClaimable(b.guest), refund), cr(A.ownerClaimable, op));
        push(cr(A.pendingGuest(b.guest), gy), cr(A.pendingOwner, oy));
      }
      e.crystallisedYield += y;
      e.lastDeferred = null;
      Object.assign(b, {
        status: "SETTLED" as BookingStatus,
        outcome: OUTCOMES[num(args.outcome)] ?? null,
        refund, ownerPrincipal: op, fee, y, guestYield: gy, ownerYield: oy,
        yieldDeferred: active,
        settledBlock: ev.blockNumber,
        settledTimestamp: ev.timestamp,
      });
      bookingOut = b;
      break;
    }
    case "BookingCancelled": {
      const b = await booking(args.bookingId);
      if (!b) break;
      b.refundBps = num(args.refundBps);
      b.outcome = OUTCOMES[num(args.outcome)] ?? b.outcome;
      bookingOut = b;
      break;
    }
    case "BookingFrozen": {
      const b = await booking(args.bookingId);
      if (!b) break;
      b.frozenFrom = STORED_STATES[num(args.from)] as BookingStatus;
      b.frozenSince = ev.timestamp;
      b.status = "FROZEN";
      bookingOut = b;
      break;
    }
    case "BookingUnfrozen": {
      const b = await booking(args.bookingId);
      if (!b) break;
      b.status = STORED_STATES[num(args.to)] as BookingStatus;
      b.frozenFrom = null;
      b.frozenSince = 0n;
      b.frozenTotal = big(args.frozenTotal);
      bookingOut = b;
      break;
    }

    // ------------------------------------------------------------------ disputes (spec 7, ADR 0011)
    case "DisputeOpened": {
      const b = await booking(args.bookingId);
      if (!b) break;
      const [c, op, fee, y] = [
        big(args.contestedAtomic), big(args.uncontestedOwnerPrincipal), big(args.uncontestedFee), big(args.y),
      ];
      const feeTo = addr(args.feeRecipient);
      if (c + op + fee !== b.principalAtomic) flag("INV-6", `dispute split != principal on ${b.bookingId}`);
      push(
        dr(A.openPrincipal, b.principalAtomic),
        cr(A.disputed, c),
        cr(A.ownerClaimable, op),
        cr(A.feeClaimable(feeTo), fee),
        dr(A.yieldUnallocated, y),
        cr(A.pendingDispute(b.bookingId), y),
      );
      e.crystallisedYield += y;
      Object.assign(b, {
        status: "DISPUTED" as BookingStatus,
        contestedAtomic: c,
        disputeYield: y,
        disputeOpenedAt: ev.timestamp,
        ownerPrincipal: op,
        fee,
        y,
      });
      bookingOut = b;
      break;
    }
    case "DisputeResolved": {
      const b = await booking(args.bookingId);
      if (!b) break;
      const [refund, op, fee, y, gy, oy] = [
        big(args.refund), big(args.ownerPrincipal), big(args.fee), big(args.y), big(args.guestYield), big(args.ownerYield),
      ];
      const feeTo = addr(args.feeRecipient);
      if (refund + op + fee !== b.contestedAtomic) flag("INV-6", `resolution != contested on ${b.bookingId}`);
      if (gy + oy !== y || y !== b.disputeYield) flag("INV-6", `dispute yield split wrong on ${b.bookingId}`);
      if (b.status !== "DISPUTED") flag("STATE", `resolved from ${b.status}`);
      const active = await lossActive(store, e);
      if (active !== deferredHere(b.bookingId)) flag("DIVERGENCE", `yield deferral mismatch on ${b.bookingId}`);
      push(
        dr(A.disputed, refund + op + fee),
        cr(A.guestClaimable(b.guest), refund),
        cr(A.ownerClaimable, op),
        cr(A.feeClaimable(feeTo), fee),
        dr(A.pendingDispute(b.bookingId), y),
      );
      if (!active) push(cr(A.guestClaimable(b.guest), gy), cr(A.ownerClaimable, oy));
      else push(cr(A.pendingGuest(b.guest), gy), cr(A.pendingOwner, oy));
      e.lastDeferred = null;
      Object.assign(b, {
        status: "SETTLED" as BookingStatus,
        outcome: "DISPUTE_RESOLVED" as const,
        refund,
        ownerPrincipal: b.ownerPrincipal + op,
        fee: b.fee + fee,
        guestYield: gy,
        ownerYield: oy,
        yieldDeferred: active,
        settledBlock: ev.blockNumber,
        settledTimestamp: ev.timestamp,
      });
      bookingOut = b;
      break;
    }

    // ------------------------------------------------------------------ claims (spec 4.5)
    case "Claimed": {
      const who = addr(args.account);
      const paid = big(args.paid);
      // LedgerLib._debit: guest bucket, then fee bucket, then the owner bucket.
      const fromGuest = min(paid, await bal(A.guestClaimable(who)));
      const left = paid - fromGuest;
      const fromFee = min(left, await bal(A.feeClaimable(who)));
      const fromOwner = left - fromFee;
      if (fromOwner > (await bal(A.ownerClaimable))) flag("DIVERGENCE", `claim by ${who} exceeds its buckets`);
      if (paid > big(args.requested)) flag("DIVERGENCE", "paid > requested");
      push(
        dr(A.guestClaimable(who), fromGuest),
        dr(A.feeClaimable(who), fromFee),
        dr(A.ownerClaimable, fromOwner),
        cr(A.idle, paid),
      );
      break;
    }
    case "PendingYieldReleased": {
      const who = addr(args.account);
      const amount = big(args.amount);
      // LedgerLib._releasePendingYield: all of the guest's pending, plus all of the owner's when the
      // caller is the payout address.
      const g = await bal(A.pendingGuest(who));
      const owner = amount - g;
      if (owner < 0n || (owner !== 0n && owner !== (await bal(A.pendingOwner)))) {
        flag("DIVERGENCE", `pending release ${amount} does not match the pending buckets of ${who}`);
      }
      push(dr(A.pendingGuest(who), g), cr(A.guestClaimable(who), g));
      if (owner > 0n) push(dr(A.pendingOwner, owner), cr(A.ownerClaimable, owner));
      break;
    }
    case "YieldDeferred":
      e.lastDeferred = `${ev.txHash.toLowerCase()}:${(args.bookingId as string).toLowerCase()}`;
      break;

    // ------------------------------------------------------------------ yield, loss, reserve (spec 6)
    case "YieldAccrued": {
      const gain = big(args.gain);
      const toReserve = big(args.toReserve);
      if (toReserve !== 0n && toReserve !== gain) flag("DIVERGENCE", "partial toReserve");
      push(dr(valuation, gain), cr(A.reserve, toReserve), cr(A.yieldUnallocated, gain - toReserve));
      e.realisedGain += gain - toReserve;
      e.accYieldPerUnit = big(args.accYieldPerUnit);
      break;
    }
    case "LossRepaid": {
      const amount = big(args.amount);
      push(dr(valuation, amount), cr(A.lossDebt, amount));
      if ((await bal(A.lossDebt)) - amount !== big(args.lossDebt)) flag("DIVERGENCE", "lossDebt after repayment");
      break;
    }
    case "LossRecognised": {
      const [loss, fromReserve, fromOwner, toDebt] = [big(args.loss), big(args.fromReserve), big(args.fromOwner), big(args.toDebt)];
      if (fromReserve + fromOwner + toDebt !== loss) flag("DIVERGENCE", "loss split does not sum");
      // LedgerLib.recogniseLoss: the owner's claim bucket first, then the owner's deferred yield.
      const fromClaim = min(fromOwner, await bal(A.ownerClaimable));
      push(
        dr(A.reserve, fromReserve),
        dr(A.ownerClaimable, fromClaim),
        dr(A.pendingOwner, fromOwner - fromClaim),
        dr(A.lossDebt, toDebt),
        cr(valuation, loss),
      );
      e.shortfallSince = 0n;
      break;
    }
    case "LossToppedUp": {
      const amount = big(args.amount);
      push(dr(A.idle, amount), cr(A.lossDebt, amount));
      if ((await bal(A.lossDebt)) - amount !== big(args.lossDebt)) flag("DIVERGENCE", "lossDebt after top-up");
      break;
    }
    case "ShortfallObserved":
      e.shortfallSince = ev.timestamp;
      break;
    case "ShortfallCleared":
      e.shortfallSince = 0n;
      break;
    case "ReserveFunded":
      push(dr(A.idle, big(args.amount)), cr(A.reserve, big(args.amount)));
      break;
    case "ReserveWithdrawalProposed":
      e.pendingReserveWithdrawal = big(args.amount);
      break;
    case "ReserveWithdrawn":
      push(dr(A.reserve, big(args.amount)), cr(A.idle, big(args.amount)));
      e.pendingReserveWithdrawal = 0n;
      break;
    case "Deployed":
      push(dr(A.deployed, big(args.assets)), cr(A.idle, big(args.assets)));
      break;
    case "Redeemed":
      push(dr(A.idle, big(args.assets)), cr(A.deployed, big(args.assets)));
      break;
    case "VaultWrittenOff":
      e.vaultWrittenOff = true;
      break;
    case "VaultRecovered":
      e.vaultWrittenOff = false;
      break;

    // ------------------------------------------------------------------ configuration (spec 3.3, 3.4)
    case "FeeChangeProposed":
      if (e.pendingFeeAt !== 0n && ev.timestamp >= e.pendingFeeAt) e.feeBps = e.pendingFeeBps; // promoted first
      e.pendingFeeBps = num(args.feeBps);
      e.pendingFeeAt = big(args.effectiveAt);
      break;
    case "ArbitratorChangeProposed":
      if (e.pendingArbitratorAt !== 0n && ev.timestamp >= e.pendingArbitratorAt) e.arbitrator = e.pendingArbitrator;
      e.pendingArbitrator = addr(args.arbitrator);
      e.pendingArbitratorAt = big(args.effectiveAt);
      break;
    case "GuestYieldBpsSet":
      e.guestYieldBps = num(args.guestYieldBps);
      break;
    case "MinNightlySet":
      e.minNightlyAtomic = big(args.minNightlyAtomic);
      break;
    case "PayoutAddressSet":
      e.payoutAddress = addr(args.payoutAddress);
      break;
    case "QuoteSignerRotated":
      e.quoteSigner = addr(args.quoteSigner);
      break;
    case "RebalancerSet":
      e.rebalancer = addr(args.rebalancer);
      break;
    case "MaxDeployBpsSet":
      e.maxDeployBps = num(args.maxDeployBps);
      break;
    case "MaxOpenPrincipalSet":
      e.maxOpenPrincipalAtomic = big(args.maxOpenPrincipalAtomic);
      break;
    case "Paused":
      e.paused = true;
      break;
    case "Unpaused":
      e.paused = false;
      break;
    default:
      if (!IGNORED.has(ev.name)) flag("UNKNOWN_EVENT", `no projection rule for ${ev.name}`);
  }

  if (legs.reduce((s, l) => s + l.amount, 0n) !== 0n) flag("UNBALANCED", `${ev.name} postings do not balance`);
  await store.post(escrow, ev, key, legs);
  if (bookingOut) await store.putBooking(bookingOut);
  await store.putEscrow(e);
  await store.markSeen(key, ev);
  return { duplicate: false, legs, anomalies };
}
