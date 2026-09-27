import type { Address, Hex } from "viem";
import type { Leg } from "./accounts.js";

/** A decoded log with the metadata the projections key on (spec 10.1: chainId, txHash, logIndex). */
export type ChainEvent = {
  name: string;
  args: Record<string, unknown>;
  chainId: number;
  address: Address;
  blockNumber: bigint;
  blockHash: Hex;
  timestamp: bigint;
  txHash: Hex;
  logIndex: number;
};

export const eventKey = (e: Pick<ChainEvent, "chainId" | "txHash" | "logIndex">) =>
  `${e.chainId}:${e.txHash.toLowerCase()}:${e.logIndex}`;

export type BookingStatus = "ESCROWED" | "FROZEN" | "DISPUTED" | "SETTLED";
export type Outcome = "COMPLETED" | "CANCELLED_BY_GUEST" | "CANCELLED_BY_PROPERTY" | "DISPUTE_RESOLVED";
export const OUTCOMES: readonly Outcome[] = ["COMPLETED", "CANCELLED_BY_GUEST", "CANCELLED_BY_PROPERTY", "DISPUTE_RESOLVED"];
export const STORED_STATES = ["NONE", "ESCROWED", "DELIVERED", "FROZEN", "DISPUTED", "SETTLED"] as const;

export type EscrowRow = {
  id: Address; // escrow address (checksummed)
  chainId: number;
  owner: Address | null;
  vault: Address | null;
  vaultWrittenOff: boolean;
  paused: boolean;
  maxFeeBps: number;
  feeBps: number;
  pendingFeeBps: number;
  pendingFeeAt: bigint; // 0 if none; effective fee is a pure function of time (spec 3.4)
  guestYieldBps: number;
  arbitrator: Address | null;
  pendingArbitrator: Address | null;
  pendingArbitratorAt: bigint;
  payoutAddress: Address | null;
  quoteSigner: Address | null;
  rebalancer: Address | null;
  maxDeployBps: number;
  maxOpenPrincipalAtomic: bigint;
  minNightlyAtomic: bigint;
  pendingReserveWithdrawal: bigint;
  // ledger scalars mirrored from events
  accYieldPerUnit: bigint;
  shortfallSince: bigint; // 0 if none
  // INV-4 inputs: realised gains to the accumulator, and yield crystallised from it
  realisedGain: bigint;
  crystallisedYield: bigint;
  /** `${txHash}:${bookingId}` of the last YieldDeferred, checked against the settlement after it. */
  lastDeferred: string | null;
};

export type BookingRow = {
  id: string; // `${escrow}:${bookingId}` lowercase
  escrow: Address;
  bookingId: Hex;
  guest: Address;
  resourceId: Hex;
  checkInUtc: bigint;
  checkOutUtc: bigint;
  principalAtomic: bigint;
  feeBps: number;
  guestYieldBps: number;
  policyHash: Hex;
  cutoffs: { cutoffUtc: number; refundBps: number }[];
  finalBps: number;
  arbitrator: Address;
  accAtDeposit: bigint;
  status: BookingStatus;
  frozenFrom: BookingStatus | null;
  frozenSince: bigint;
  frozenTotal: bigint;
  outcome: Outcome | null;
  refundBps: number | null;
  contestedAtomic: bigint;
  disputeYield: bigint;
  disputeOpenedAt: bigint;
  // settlement figures (sum of the dispute's two calls for a disputed booking)
  refund: bigint;
  ownerPrincipal: bigint;
  fee: bigint;
  y: bigint;
  guestYield: bigint;
  ownerYield: bigint;
  yieldDeferred: boolean;
  depositBlock: bigint;
  depositBlockHash: Hex;
  depositTx: Hex;
  depositTimestamp: bigint;
  settledBlock: bigint | null;
  settledTimestamp: bigint | null;
};

export type JournalRow = {
  id: string; // `${eventKey}:${leg}`
  escrow: Address;
  eventKey: string;
  eventName: string;
  blockNumber: bigint;
  timestamp: bigint;
  account: string;
  amount: bigint; // debit positive
};

/** What a projection store must provide; implemented in memory (tests, replay diff) and on Ponder. */
export interface Store {
  seen(key: string): Promise<boolean>;
  markSeen(key: string, ev: ChainEvent): Promise<void>;
  getEscrow(escrow: Address): Promise<EscrowRow | undefined>;
  putEscrow(row: EscrowRow): Promise<void>;
  getBooking(escrow: Address, bookingId: Hex): Promise<BookingRow | undefined>;
  putBooking(row: BookingRow): Promise<void>;
  balance(escrow: Address, account: string): Promise<bigint>;
  post(escrow: Address, ev: ChainEvent, key: string, legs: Leg[]): Promise<void>;
}

export type Anomaly = { code: string; message: string; eventKey: string; escrow: Address };
export type ReduceResult = { duplicate: boolean; legs: Leg[]; anomalies: Anomaly[] };
