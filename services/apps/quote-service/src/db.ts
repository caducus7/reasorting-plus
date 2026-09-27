// Postgres access (node-postgres). Timestamps are passed in explicitly (chain time), never read from
// the database clock, so every expiry decision uses the same notion of "now" as the contract.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

export type Db = pg.Pool;

export function connect(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 10 });
}

/** Applies migrations/*.sql in order, once each, inside a transaction guarded by an advisory lock. */
export async function migrate(db: Db): Promise<void> {
  const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const c = await db.connect();
  try {
    await c.query("SELECT pg_advisory_lock(7427001)");
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const f of files) {
      const done = await c.query("SELECT 1 FROM schema_migrations WHERE name = $1", [f]);
      if (done.rowCount) continue;
      await c.query("BEGIN");
      try {
        await c.query(readFileSync(dir + f, "utf8"));
        await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(7427001)").catch(() => {});
    c.release();
  }
}

export type OfferRow = {
  offer_id: string;
  chain_id: number;
  escrow: string;
  resource_id: string;
  check_in: string;
  check_out: string;
  guests: number;
  price_atomic: string;
  policy_id: string;
  session_id: string | null;
  expires_at: Date;
};

export class SlotTaken extends Error {}

const EXCLUSION_VIOLATION = "23P01";
const RETRYABLE = new Set(["40P01", "40001"]); // deadlock_detected, serialization_failure

/**
 * Advisory-lock key for a resource's holds: the first 8 bytes of sha256, as the documented
 * `pg_advisory_xact_lock(bigint)` argument. Computed here rather than with the server's
 * undocumented hashtextextended(), whose output carries no stability guarantee.
 */
export function holdLockKey(resourceId: string): bigint {
  return createHash("sha256").update(`hold:${resourceId.toLowerCase()}`).digest().readBigInt64BE(0);
}

/**
 * Inserts an offer and its soft hold atomically. Expired holds on the slot are released first in
 * the same transaction; an overlapping active hold makes the insert fail with SlotTaken.
 *
 * Concurrency (PostgreSQL docs, "Deadlocks"): exclusion-constraint checks can deadlock when two
 * backends insert conflicting rows at once (execIndexing.c: "fairly harmless ... although you get
 * a different error message"). The docs' first remedy is to take the most restrictive lock first,
 * in a consistent order: a transaction-level advisory lock per resource. The second is to retry
 * transactions aborted by a deadlock, kept here as a bounded backstop.
 */
export async function createOfferWithHold(db: Db, o: Omit<OfferRow, "expires_at"> & { now: Date; expiresAt: Date }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await createOfferWithHoldOnce(db, o);
    } catch (e) {
      if (attempt < 3 && RETRYABLE.has((e as { code?: string }).code ?? "")) continue;
      throw e;
    }
  }
}

async function createOfferWithHoldOnce(db: Db, o: Omit<OfferRow, "expires_at"> & { now: Date; expiresAt: Date }) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock($1::bigint)", [holdLockKey(o.resource_id).toString()]);
    await c.query(
      "UPDATE holds SET active = false WHERE active AND resource_id = $1 AND expires_at <= $2 AND stay && daterange($3::date, $4::date)",
      [o.resource_id, o.now, o.check_in, o.check_out],
    );
    await c.query(
      `INSERT INTO offers (offer_id, chain_id, escrow, resource_id, check_in, check_out, guests, price_atomic,
         policy_id, session_id, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [o.offer_id, o.chain_id, o.escrow, o.resource_id, o.check_in, o.check_out, o.guests, o.price_atomic,
        o.policy_id, o.session_id, o.now, o.expiresAt],
    );
    await c.query(
      "INSERT INTO holds (offer_id, resource_id, stay, expires_at) VALUES ($1, $2, daterange($3::date, $4::date), $5)",
      [o.offer_id, o.resource_id, o.check_in, o.check_out, o.expiresAt],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    if ((e as { code?: string }).code === EXCLUSION_VIOLATION) throw new SlotTaken();
    throw e;
  } finally {
    c.release();
  }
}

export async function getOffer(db: Db, offerId: string): Promise<OfferRow | null> {
  const r = await db.query(
    `SELECT offer_id, chain_id, escrow, resource_id, to_char(check_in, 'YYYY-MM-DD') AS check_in,
       to_char(check_out, 'YYYY-MM-DD') AS check_out, guests, price_atomic::text AS price_atomic, policy_id,
       session_id, expires_at FROM offers WHERE offer_id = $1`,
    [offerId],
  );
  return (r.rows[0] as OfferRow | undefined) ?? null;
}

/** Is the slot held by an active, unexpired hold other than `exceptOfferId`? */
export async function slotHeldByOther(
  db: Db,
  resourceId: string,
  checkIn: string,
  checkOut: string,
  now: Date,
  exceptOfferId: string | null,
): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM holds WHERE active AND resource_id = $1 AND expires_at > $2
       AND stay && daterange($3::date, $4::date) AND ($5::uuid IS NULL OR offer_id <> $5::uuid) LIMIT 1`,
    [resourceId, now, checkIn, checkOut, exceptOfferId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Is our own hold on the offer still active and unexpired? */
export async function holdIsLive(db: Db, offerId: string, now: Date): Promise<boolean> {
  const r = await db.query("SELECT 1 FROM holds WHERE offer_id = $1 AND active AND expires_at > $2", [offerId, now]);
  return (r.rowCount ?? 0) > 0;
}

export type QuoteRow = {
  booking_id: string;
  guest: string;
  quote: unknown;
  quote_sig: string;
  expires_at: Date;
};

export async function liveQuoteForOffer(db: Db, offerId: string, now: Date): Promise<QuoteRow | null> {
  const r = await db.query(
    "SELECT booking_id, guest, quote, quote_sig, expires_at FROM quotes WHERE offer_id = $1 AND expires_at > $2 ORDER BY created_at DESC LIMIT 1",
    [offerId, now],
  );
  return (r.rows[0] as QuoteRow | undefined) ?? null;
}

/** A hold whose quote was signed: released only on proof (migrations/003, docs/adr/0012 §3). */
export type AwaitingHold = { offer_id: string; resource_id: string; booking_id: string; until: number };

export async function awaitingHolds(db: Db, resourceId: string, checkIn: string, checkOut: string): Promise<AwaitingHold[]> {
  const r = await db.query(
    `SELECT offer_id, resource_id, awaiting_booking_id AS booking_id, awaiting_until::text AS until FROM holds
       WHERE active AND awaiting_booking_id IS NOT NULL AND resource_id = $1 AND stay && daterange($2::date, $3::date)`,
    [resourceId, checkIn, checkOut],
  );
  return r.rows.map((x) => ({ ...x, until: Number(x.until) }) as AwaitingHold);
}

export async function awaitingHoldOfOffer(db: Db, offerId: string): Promise<AwaitingHold | null> {
  const r = await db.query(
    `SELECT offer_id, resource_id, awaiting_booking_id AS booking_id, awaiting_until::text AS until FROM holds
       WHERE active AND awaiting_booking_id IS NOT NULL AND offer_id = $1`,
    [offerId],
  );
  const x = r.rows[0];
  return x ? ({ ...x, until: Number(x.until) } as AwaitingHold) : null;
}

/** Releases an awaiting hold, only if it still awaits the same booking. */
export async function releaseAwaitingHold(db: Db, h: AwaitingHold): Promise<void> {
  await db.query("UPDATE holds SET active = false WHERE offer_id = $1 AND active AND awaiting_booking_id = $2", [
    h.offer_id,
    h.booking_id,
  ]);
}

/**
 * Records a signed quote and turns the offer's hold into an awaiting-payment hold: it stops expiring
 * on the server clock and is released only on proof (see awaitingHolds). Serialised per offer with
 * a row lock so two concurrent prepares cannot both issue a live quote.
 */
export async function recordQuote(
  db: Db,
  q: {
    chainId: number;
    escrow: string;
    bookingId: string;
    offerId: string;
    guest: string;
    email: string;
    sessionId: string | null;
    quote: unknown;
    quoteSig: string;
    expiresAt: Date;
    /** The quote's expiresAt in chain time: after the chain passes it, the escrow rejects the quote. */
    expiresAtChain: number;
    now: Date;
  },
): Promise<"recorded" | "conflict"> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT 1 FROM offers WHERE offer_id = $1 FOR UPDATE", [q.offerId]);
    const live = await c.query("SELECT 1 FROM quotes WHERE offer_id = $1 AND expires_at > $2 LIMIT 1", [q.offerId, q.now]);
    if (live.rowCount) {
      await c.query("ROLLBACK");
      return "conflict";
    }
    await c.query(
      `INSERT INTO quotes (chain_id, escrow, booking_id, offer_id, guest, email, session_id, quote, quote_sig, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [q.chainId, q.escrow.toLowerCase(), q.bookingId.toLowerCase(), q.offerId, q.guest.toLowerCase(), q.email,
        q.sessionId, JSON.stringify(q.quote), q.quoteSig, q.expiresAt, q.now],
    );
    await c.query(
      "UPDATE holds SET expires_at = 'infinity', awaiting_booking_id = $2, awaiting_until = $3 WHERE offer_id = $1",
      [q.offerId, q.bookingId.toLowerCase(), q.expiresAtChain],
    );
    await c.query("COMMIT");
    return "recorded";
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

export async function bookingEmail(db: Db, chainId: number, escrow: string, bookingId: string): Promise<string | null> {
  const r = await db.query("SELECT email FROM quotes WHERE chain_id = $1 AND escrow = $2 AND booking_id = $3", [
    chainId,
    escrow.toLowerCase(),
    bookingId.toLowerCase(),
  ]);
  return (r.rows[0]?.email as string | undefined) ?? null;
}

// ------------------------------------------------------------------ calendar (read-only; C6/C7 own it)

export interface CalendarPort {
  /** Any escrow booking or imported channel event overlapping [checkIn, checkOut)? */
  isBusy(resourceId: string, checkIn: string, checkOut: string): Promise<boolean>;
  /** Channel feeds for the resource whose last successful import is older than `maxAgeSec`. */
  staleFeeds(resourceId: string, now: Date, maxAgeSec: number): Promise<string[]>;
  /** Has the indexer (C6) projected this escrow booking into the calendar? */
  hasEscrowBooking(resourceId: string, bookingId: string): Promise<boolean>;
}

export function pgCalendar(db: Db): CalendarPort {
  return {
    async isBusy(resourceId, checkIn, checkOut) {
      const r = await db.query(
        "SELECT 1 FROM calendar_blocks WHERE resource_id = $1 AND stay && daterange($2::date, $3::date) LIMIT 1",
        [resourceId, checkIn, checkOut],
      );
      return (r.rowCount ?? 0) > 0;
    },
    async staleFeeds(resourceId, now, maxAgeSec) {
      const r = await db.query(
        `SELECT feed_id FROM channel_feeds WHERE resource_id = $1
           AND (last_success_at IS NULL OR last_success_at < $2::timestamptz - make_interval(secs => $3))`,
        [resourceId, now, maxAgeSec],
      );
      return r.rows.map((x) => x.feed_id as string);
    },
    async hasEscrowBooking(resourceId, bookingId) {
      const r = await db.query(
        "SELECT 1 FROM calendar_blocks WHERE resource_id = $1 AND source = 'escrow' AND lower(ref) = $2 LIMIT 1",
        [resourceId, bookingId.toLowerCase()],
      );
      return (r.rowCount ?? 0) > 0;
    },
  };
}
