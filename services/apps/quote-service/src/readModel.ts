// Booking read model for GET /v1/bookings/{id}, cancel-preview and yield terms. C6 (indexer) owns the
// production read model; until it lands this interim implementation reads the escrow directly over
// RPC (C5 brief: "back them with an interface"). It uses only views and indexed-event lookups.

import { parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { escrowAbi } from "@chain/abi";
import { bookingYield, type Cutoff } from "@chain/shared";
import type { v1 } from "@chain/shared";

export type BookingView = {
  state: v1.BookingState;
  outcome: v1.BookingOutcome | null;
  guest: Address;
  resourceId: Hex;
  checkInUtc: number;
  checkOutUtc: number;
  principalAtomic: bigint;
  feeBps: number;
  guestYieldBps: number;
  finalBps: number;
  cutoffs: Cutoff[];
  /** Guest's share of yield accrued so far (open), or credited at settlement (settled). */
  accruedGuestYieldAtomic: bigint;
  /** What the guest can claim now on this escrow (claim buckets are per address, ADR 0003). */
  claimableAtomic: bigint;
  txHash: Hex;
};

export interface BookingReadModel {
  getBooking(bookingId: Hex): Promise<BookingView | null>;
}

const STATES = ["NONE", "ESCROWED", "DELIVERED", "FROZEN", "DISPUTED", "SETTLED"] as const;
const OUTCOMES = ["COMPLETED", "CANCELLED_BY_GUEST", "CANCELLED_BY_PROPERTY", "DISPUTE_RESOLVED"] as const;

const DEPOSITED = parseAbiItem(
  "event BookingDeposited(bytes32 indexed bookingId, address indexed guest, bytes32 indexed resourceId, uint40 checkInUtc, uint40 checkOutUtc, uint256 principalAtomic, uint16 feeBps, uint16 guestYieldBps, bytes32 policyHash, (uint40 cutoffUtc, uint16 refundBps)[] cutoffs, uint16 finalBps, address arbitrator, uint256 accAtDeposit)",
);
const SETTLED = parseAbiItem(
  "event BookingSettled(bytes32 indexed bookingId, uint8 outcome, uint256 principalAtomic, uint256 refund, uint256 ownerPrincipal, uint256 fee, uint256 y, uint256 guestYield, uint256 ownerYield, address feeRecipient)",
);
const RESOLVED = parseAbiItem(
  "event DisputeResolved(bytes32 indexed bookingId, uint16 guestBps, uint8 reasonCode, uint256 refund, uint256 ownerPrincipal, uint256 fee, uint256 y, uint256 guestYield, uint256 ownerYield, address feeRecipient)",
);

export function chainReadModel(client: PublicClient, escrow: Address, fromBlock: bigint): BookingReadModel {
  const read = <T>(functionName: string, args: unknown[] = []) =>
    client.readContract({ address: escrow, abi: escrowAbi, functionName: functionName as never, args: args as never }) as Promise<T>;

  return {
    async getBooking(bookingId) {
      const b = await read<{
        guest: Address;
        checkInUtc: number;
        checkOutUtc: number;
        feeBps: number;
        state: number;
        guestYieldBps: number;
        finalBps: number;
        resourceId: Hex;
        principalAtomic: bigint;
        accAtDeposit: bigint;
      }>("getBooking", [bookingId]);
      if (b.state === 0) return null;
      const [derived, cutoffs, acc, claimable, deposits] = await Promise.all([
        read<number>("bookingState", [bookingId]),
        read<readonly { cutoffUtc: number; refundBps: number }[]>("getCutoffs", [bookingId]),
        read<bigint>("accYieldPerUnit"),
        read<bigint>("claimableOf", [b.guest]),
        client.getLogs({ address: escrow, event: DEPOSITED, args: { bookingId }, fromBlock }),
      ]);
      const state = STATES[derived] as v1.BookingState;
      let outcome: v1.BookingOutcome | null = null;
      let accrued = (bookingYield(b.principalAtomic, acc, b.accAtDeposit) * BigInt(b.guestYieldBps)) / 10_000n;
      if (state === "SETTLED") {
        const [settled, resolved] = await Promise.all([
          client.getLogs({ address: escrow, event: SETTLED, args: { bookingId }, fromBlock }),
          client.getLogs({ address: escrow, event: RESOLVED, args: { bookingId }, fromBlock }),
        ]);
        if (resolved[0]) {
          outcome = "DISPUTE_RESOLVED";
          accrued = resolved[0].args.guestYield!;
        } else if (settled[0]) {
          outcome = OUTCOMES[Number(settled[0].args.outcome)]!;
          accrued = settled[0].args.guestYield!;
        }
      }
      return {
        state,
        outcome,
        guest: b.guest,
        resourceId: b.resourceId,
        checkInUtc: Number(b.checkInUtc),
        checkOutUtc: Number(b.checkOutUtc),
        principalAtomic: b.principalAtomic,
        feeBps: Number(b.feeBps),
        guestYieldBps: Number(b.guestYieldBps),
        finalBps: Number(b.finalBps),
        cutoffs: cutoffs.map((c) => ({ cutoffUtc: Number(c.cutoffUtc), refundBps: Number(c.refundBps) })),
        accruedGuestYieldAtomic: accrued,
        claimableAtomic: claimable,
        txHash: (deposits[0]?.transactionHash ?? `0x${"00".repeat(32)}`) as Hex,
      };
    },
  };
}
