// Escrow rows of the shared calendar_blocks table (docs/adr/0012 §3, brief "Decided"). Ponder cannot
// roll back a table it does not own, so the rows are derived here from the projection on every tick:
// the table always equals a function of the projection plus the head milestones.
//
//   - one row per booking, from the unsafe head (the projection holds it);
//   - removed when the deposit is rolled back, unless it had reached safe (then it stays blocked and
//     the deep reorg pages: brief C6 test 1);
//   - removed on cancellation once the cancellation is at the safe head (a cancellation that could
//     still be reorged away must not free a slot another guest could then take).
import type pg from "pg";
import { DateTime } from "luxon";
import type { Breach } from "../core/invariants.js";
import type { BookingRow } from "../core/types.js";
import type { Heads } from "./heads.js";
import type { Snapshot } from "./projection.js";

export type Stay = { from: string; to: string };

/** Property-local [checkIn, checkOut) dates of a booking (spec 5.1: the property's IANA zone). */
export function localStay(b: Pick<BookingRow, "checkInUtc" | "checkOutUtc">, tz: string): Stay {
  const d = (t: bigint) => DateTime.fromSeconds(Number(t), { zone: tz }).toISODate()!;
  return { from: d(b.checkInUtc), to: d(b.checkOutUtc) };
}

const CANCELLED = new Set(["CANCELLED_BY_GUEST", "CANCELLED_BY_PROPERTY"]);

export async function syncCalendar(
  pool: pg.Pool,
  chainId: number,
  snap: Snapshot,
  heads: Heads,
  zones: Map<string, string>,
): Promise<{ added: number; removed: number; breaches: Breach[] }> {
  const breaches: Breach[] = [];
  const desired = new Map<string, { resourceId: string; stay: Stay }>();
  for (const b of snap.bookings) {
    if (CANCELLED.has(b.outcome ?? "") && b.settledBlock !== null && b.settledBlock <= heads.safe.number) continue;
    const tz = zones.get(b.resourceId.toLowerCase());
    if (!tz) {
      breaches.push({
        invariant: "CALENDAR",
        severity: "alert",
        key: `CALENDAR:unknown-resource:${b.resourceId}`,
        escrow: b.escrow,
        message: `booking ${b.bookingId} is for resource ${b.resourceId}, which has no configured time zone; blocked in UTC`,
        response: ["alert_owner"],
      });
    }
    desired.set(b.bookingId.toLowerCase(), { resourceId: b.resourceId.toLowerCase(), stay: localStay(b, tz ?? "UTC") });
  }
  // Deposits that reached safe and were then reorged out keep their slot (brief C6 test 1).
  const sticky = new Set(
    (
      await pool.query(
        `SELECT DISTINCT booking_id FROM indexer_ops.booking_milestones m
         WHERE chain_id = $1 AND milestone IN ('safe', 'finalized')
           AND EXISTS (SELECT 1 FROM indexer_ops.booking_milestones r
                       WHERE r.chain_id = m.chain_id AND r.booking_id = m.booking_id
                         AND r.deposit_hash = m.deposit_hash AND r.milestone = 'reverted')`,
        [chainId],
      )
    ).rows.map((r) => (r.booking_id as string).toLowerCase()),
  );

  const c = await pool.connect();
  let added = 0;
  let removed = 0;
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext('c6.calendar_blocks.escrow'))");
    const existing = (await c.query("SELECT resource_id, ref FROM calendar_blocks WHERE source = 'escrow'")).rows as {
      resource_id: string;
      ref: string;
    }[];
    const have = new Set(existing.map((r) => r.ref.toLowerCase()));
    for (const r of existing) {
      const ref = r.ref.toLowerCase();
      if (desired.has(ref) || sticky.has(ref)) continue;
      await c.query("DELETE FROM calendar_blocks WHERE resource_id = $1 AND source = 'escrow' AND ref = $2", [r.resource_id, r.ref]);
      removed++;
    }
    for (const [ref, d] of desired) {
      if (have.has(ref)) continue;
      await c.query(
        "INSERT INTO calendar_blocks (resource_id, stay, source, ref) VALUES ($1, daterange($2::date, $3::date), 'escrow', $4) ON CONFLICT DO NOTHING",
        [d.resourceId, d.stay.from, d.stay.to, ref],
      );
      added++;
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  return { added, removed, breaches };
}
