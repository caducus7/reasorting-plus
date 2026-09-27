// Reads Ponder's projection tables (or their views) as one consistent snapshot, with the block the
// snapshot is complete up to (Ponder's latest checkpoint).
import type pg from "pg";
import type { Address, Hex } from "viem";
import type { BookingRow, EscrowRow } from "../core/types.js";

export type Snapshot = {
  block: bigint; // every event up to and including this block is in the snapshot
  escrows: EscrowRow[];
  bookings: BookingRow[];
  balances: Map<string, Map<string, bigint>>; // escrow (lowercase) -> account -> balance
  anomalies: { id: string; escrow: string; code: string; message: string; blockNumber: bigint }[];
};

const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const BIG = new Set([
  "pendingFeeAt", "pendingArbitratorAt", "maxOpenPrincipalAtomic", "minNightlyAtomic", "pendingReserveWithdrawal",
  "accYieldPerUnit", "shortfallSince", "realisedGain", "crystallisedYield", "updatedBlock", "checkInUtc", "checkOutUtc",
  "principalAtomic", "accAtDeposit", "frozenSince", "frozenTotal", "contestedAtomic", "disputeYield", "disputeOpenedAt",
  "refund", "ownerPrincipal", "fee", "y", "guestYield", "ownerYield", "depositBlock", "depositTimestamp", "settledBlock",
  "settledTimestamp", "amount", "blockNumber",
]);

function row<T>(r: Record<string, unknown>): T {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    const c = camel(k);
    o[c] = v !== null && BIG.has(c) ? BigInt(v as string) : v;
  }
  return o as T;
}

/** Block number inside a Ponder checkpoint string (utils/checkpoint.ts: 10 + 16 digits, then 16). */
export const checkpointBlock = (cp: string) => BigInt(cp.slice(26, 42));

export async function readSnapshot(pool: pg.Pool, schema: string): Promise<Snapshot> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const cp = await c.query(`SELECT latest_checkpoint FROM "${schema}"._ponder_checkpoint`);
    const block = cp.rows[0] ? checkpointBlock(cp.rows[0].latest_checkpoint as string) : 0n;
    const escrows = (await c.query(`SELECT * FROM "${schema}".escrow`)).rows.map((r) => row<EscrowRow>(r));
    const bookings = (await c.query(`SELECT * FROM "${schema}".booking`)).rows.map((r) => row<BookingRow>(r));
    const bal = (await c.query(`SELECT escrow, account, amount FROM "${schema}".balance WHERE amount <> 0`)).rows;
    const anomalies = (await c.query(`SELECT id, escrow, code, message, block_number FROM "${schema}".anomaly`)).rows.map(
      (r) => row<Snapshot["anomalies"][number]>(r),
    );
    await c.query("COMMIT");
    const balances = new Map<string, Map<string, bigint>>();
    for (const r of bal) {
      const e = (r.escrow as string).toLowerCase();
      const m = balances.get(e) ?? new Map<string, bigint>();
      m.set(r.account as string, BigInt(r.amount as string));
      balances.set(e, m);
    }
    return { block, escrows, bookings, balances, anomalies };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export type { Address, Hex };
