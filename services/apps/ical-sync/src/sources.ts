// C7's reads of C6's projection (through the views schema) and head milestones (indexer_ops).
import type pg from "pg";
import type { Escrowed } from "./importer.js";
import type { Exportable } from "./export.js";

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`bad schema name ${s}`);
  return `"${s}"`;
};

/** Bookings to export for a resource (spec 10.2 "mark the room sold and export to iCal: safe"):
 *   the deposit is at the safe head (its block hash is the one that reached safe), and
 *   it is not cancelled with the cancellation at the safe head (ADR 0017 §2). A deposit reorged out
 *   after safe is gone from the projection, so it leaves the export on the next request. */
export function exportableSource(pool: pg.Pool, schema: string, chainId: number, keepPastDays = 30) {
  const s = ident(schema);
  return async (resourceId: string): Promise<Exportable[]> => {
    const r = await pool.query(
      `SELECT b.booking_id, b.check_in_utc, b.check_out_utc, b.deposit_timestamp
         FROM ${s}.booking b
        WHERE b.resource_id = $1
          AND b.check_out_utc >= extract(epoch FROM now())::bigint - $3 * 86400
          AND EXISTS (SELECT 1 FROM indexer_ops.booking_milestones m
                       WHERE m.chain_id = $2 AND m.escrow = lower(b.escrow) AND m.booking_id = lower(b.booking_id)
                         AND m.deposit_hash = lower(b.deposit_block_hash) AND m.milestone = 'safe')
          AND NOT (coalesce(b.outcome, '') IN ('CANCELLED_BY_GUEST', 'CANCELLED_BY_PROPERTY')
                   AND b.settled_block <= (SELECT number FROM indexer_ops.chain_heads WHERE chain_id = $2 AND tag = 'safe'))`,
      [resourceId.toLowerCase(), chainId, keepPastDays],
    );
    return r.rows.map((x) => ({
      bookingId: x.booking_id,
      checkInUtc: BigInt(x.check_in_utc),
      checkOutUtc: BigInt(x.check_out_utc),
      depositTimestamp: BigInt(x.deposit_timestamp),
    }));
  };
}

/** ESCROWED bookings whose stay has not ended: the same set C6's INV-3 checks. */
export function escrowedSource(pool: pg.Pool, schema: string) {
  const s = ident(schema);
  return async (resourceId: string, now: Date): Promise<Escrowed[]> => {
    const r = await pool.query(
      `SELECT escrow, booking_id, resource_id, check_in_utc, check_out_utc FROM ${s}.booking
        WHERE resource_id = $1 AND status = 'ESCROWED' AND check_out_utc > $2`,
      [resourceId.toLowerCase(), Math.floor(now.getTime() / 1000)],
    );
    return r.rows.map((x) => ({
      escrow: x.escrow,
      bookingId: x.booking_id,
      resourceId: x.resource_id,
      checkInUtc: BigInt(x.check_in_utc),
      checkOutUtc: BigInt(x.check_out_utc),
    }));
  };
}
