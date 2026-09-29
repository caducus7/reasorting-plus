// Booking read model for GET /v1/bookings/{id}, cancel-preview and yield terms, behind an interface
// (C5 brief). Production: `indexerReadModel`, the C6 indexer's read API (INDEXER_URL). Fallback when
// no indexer is configured: `chainReadModel`, direct escrow views over RPC.

import { getAddress, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { z } from "zod";
import { escrowAbi } from "@chain/abi";
import { bookingYield, type Cutoff } from "@chain/shared";
import { v1 } from "@chain/shared";

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
  /** Seconds the booking spent frozen: its policy clock runs this far behind (docs/adr/0015 §1). */
  frozenTotal: number;
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
        frozenTotal: number;
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
        frozenTotal: Number(b.frozenTotal),
        cutoffs: cutoffs.map((c) => ({ cutoffUtc: Number(c.cutoffUtc), refundBps: Number(c.refundBps) })),
        accruedGuestYieldAtomic: accrued,
        claimableAtomic: claimable,
        txHash: (deposits[0]?.transactionHash ?? `0x${"00".repeat(32)}`) as Hex,
      };
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Production read model: the C6 indexer's read API (docs/adr/0017 §8). Same BookingView, from the
// projection instead of RPC. Every response is validated; anything unexpected is an error, never a
// guess. A booking the indexer has not seen yet (deposit newer than its checkpoint) reads as unknown,
// which the API already treats like "not yours" (403), so nothing is revealed early.

const Atomic = z.string().regex(/^(0|[1-9][0-9]*)$/).transform(BigInt);
const Hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((s) => s.toLowerCase() as Hex);
const Addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((s) => getAddress(s)); // Ponder stores lowercase
const IndexerBooking = z.object({
  bookingId: Hex32,
  state: v1.BookingState,
  outcome: v1.BookingOutcome.nullable(),
  guest: Addr,
  resourceId: Hex32,
  checkInUtc: z.number().int(),
  checkOutUtc: z.number().int(),
  principalAtomic: Atomic,
  feeBps: z.number().int().min(0).max(10_000),
  guestYieldBps: z.number().int().min(0).max(10_000),
  finalBps: z.number().int().min(0).max(10_000),
  cutoffs: z.array(z.object({ cutoffUtc: z.number().int(), refundBps: z.number().int().min(0).max(10_000) })),
  frozenTotal: z.number().int().min(0),
  accruedGuestYieldAtomic: Atomic,
  claimableAtomic: Atomic,
  txHash: Hex32,
});

export function indexerReadModel(
  baseUrl: string,
  escrow: Address,
  opts: { timeoutMs?: number; fetch?: typeof fetch; token?: string } = {},
): BookingReadModel {
  const f = opts.fetch ?? fetch;
  const base = baseUrl.replace(/\/+$/, "");
  return {
    async getBooking(bookingId) {
      const r = await f(`${base}/v1/indexer/bookings/${escrow}/${bookingId}`, {
        signal: AbortSignal.timeout(opts.timeoutMs ?? 2_000),
        headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
      });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`indexer read API ${r.status}`);
      const b = IndexerBooking.parse(await r.json());
      if (b.bookingId !== bookingId.toLowerCase()) throw new Error("indexer returned a different booking");
      const { bookingId: _id, ...view } = b;
      return view;
    },
  };
}

/** Indexer first, chain as a read-through fallback (review 0005 R7): a booking newer than the
 * indexer's checkpoint, or an indexer outage, degrades to direct escrow reads instead of telling a
 * guest who just paid that the booking is not theirs. */
export function withFallback(primary: BookingReadModel, fallback: BookingReadModel, warn: (m: string) => void = console.warn): BookingReadModel {
  return {
    async getBooking(bookingId) {
      try {
        const v = await primary.getBooking(bookingId);
        if (v) return v;
      } catch (e) {
        warn(`indexer read failed, using the chain: ${(e as Error).message}`);
      }
      return fallback.getBooking(bookingId);
    },
  };
}
