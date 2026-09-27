// Projection tables. Ponder rolls every table here back on a reorg (docs/adr/0014), so nothing
// outside this file may hold projection state (brief: "never hold state replay can't reproduce").
import { index, onchainTable } from "ponder";

export const escrow = onchainTable("escrow", (t) => ({
  id: t.hex().primaryKey(),
  chainId: t.integer().notNull(),
  owner: t.hex(),
  vault: t.hex(),
  vaultWrittenOff: t.boolean().notNull(),
  paused: t.boolean().notNull(),
  maxFeeBps: t.integer().notNull(),
  feeBps: t.integer().notNull(),
  pendingFeeBps: t.integer().notNull(),
  pendingFeeAt: t.bigint().notNull(),
  guestYieldBps: t.integer().notNull(),
  arbitrator: t.hex(),
  pendingArbitrator: t.hex(),
  pendingArbitratorAt: t.bigint().notNull(),
  payoutAddress: t.hex(),
  quoteSigner: t.hex(),
  rebalancer: t.hex(),
  maxDeployBps: t.integer().notNull(),
  maxOpenPrincipalAtomic: t.bigint().notNull(),
  minNightlyAtomic: t.bigint().notNull(),
  pendingReserveWithdrawal: t.bigint().notNull(),
  accYieldPerUnit: t.bigint().notNull(),
  shortfallSince: t.bigint().notNull(),
  realisedGain: t.bigint().notNull(),
  crystallisedYield: t.bigint().notNull(),
  lastDeferred: t.text(),
  updatedBlock: t.bigint().notNull(),
}));

export const booking = onchainTable(
  "booking",
  (t) => ({
    id: t.text().primaryKey(), // `${escrow}:${bookingId}`, lowercase
    escrow: t.hex().notNull(),
    bookingId: t.hex().notNull(),
    guest: t.hex().notNull(),
    resourceId: t.hex().notNull(),
    checkInUtc: t.bigint().notNull(),
    checkOutUtc: t.bigint().notNull(),
    principalAtomic: t.bigint().notNull(),
    feeBps: t.integer().notNull(),
    guestYieldBps: t.integer().notNull(),
    policyHash: t.hex().notNull(),
    cutoffs: t.json().$type<{ cutoffUtc: number; refundBps: number }[]>().notNull(),
    finalBps: t.integer().notNull(),
    arbitrator: t.hex().notNull(),
    accAtDeposit: t.bigint().notNull(),
    status: t.text().notNull(),
    frozenFrom: t.text(),
    frozenSince: t.bigint().notNull(),
    frozenTotal: t.bigint().notNull(),
    outcome: t.text(),
    refundBps: t.integer(),
    contestedAtomic: t.bigint().notNull(),
    disputeYield: t.bigint().notNull(),
    disputeOpenedAt: t.bigint().notNull(),
    refund: t.bigint().notNull(),
    ownerPrincipal: t.bigint().notNull(),
    fee: t.bigint().notNull(),
    y: t.bigint().notNull(),
    guestYield: t.bigint().notNull(),
    ownerYield: t.bigint().notNull(),
    yieldDeferred: t.boolean().notNull(),
    depositBlock: t.bigint().notNull(),
    depositBlockHash: t.hex().notNull(),
    depositTx: t.hex().notNull(),
    depositTimestamp: t.bigint().notNull(),
    settledBlock: t.bigint(),
    settledTimestamp: t.bigint(),
    updatedBlock: t.bigint().notNull(),
  }),
  (t) => ({ byEscrow: index().on(t.escrow), byGuest: index().on(t.guest), byResource: index().on(t.resourceId) }),
);

export const balance = onchainTable(
  "balance",
  (t) => ({
    id: t.text().primaryKey(), // `${escrow}:${account}`
    escrow: t.hex().notNull(),
    account: t.text().notNull(),
    amount: t.bigint().notNull(),
  }),
  (t) => ({ byEscrow: index().on(t.escrow) }),
);

export const journal = onchainTable(
  "journal",
  (t) => ({
    id: t.text().primaryKey(), // `${chainId}:${txHash}:${logIndex}:${leg}`
    escrow: t.hex().notNull(),
    eventKey: t.text().notNull(),
    eventName: t.text().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    account: t.text().notNull(),
    amount: t.bigint().notNull(), // debit positive
  }),
  (t) => ({ byEscrowBlock: index().on(t.escrow, t.blockNumber) }),
);

export const processedEvent = onchainTable(
  "processed_event",
  (t) => ({
    id: t.text().primaryKey(), // `${chainId}:${txHash}:${logIndex}` (spec 10.1)
    escrow: t.hex().notNull(),
    name: t.text().notNull(),
    blockNumber: t.bigint().notNull(),
    blockHash: t.hex().notNull(),
    txHash: t.hex().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (t) => ({ byBlock: index().on(t.blockNumber) }),
);

/** Inconsistencies found while projecting (INV-6, divergence from the contract's rules). */
export const anomaly = onchainTable("anomaly", (t) => ({
  id: t.text().primaryKey(),
  escrow: t.hex().notNull(),
  code: t.text().notNull(),
  message: t.text().notNull(),
  eventKey: t.text().notNull(),
  blockNumber: t.bigint().notNull(),
}));
