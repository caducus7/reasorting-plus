// Postgres access (node-postgres). Timestamps are passed in explicitly (chain time), never read from
// the database clock, so every expiry decision uses the same notion of "now" as the contract.

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

/**
 * Inserts an offer and its soft hold atomically. Expired holds on the slot are released first in
 * the same transaction; an overlapping active hold makes the insert fail with SlotTaken.
 */
export async function createOfferWithHold(db: Db, o: Omit<OfferRow, "expires_at"> & { now: Date; expiresAt: Date }) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    // Serialise hold creation per resource. Without this, concurrent overlapping inserts can
    // deadlock inside the exclusion check (40P01) and a guest sees a 500 instead of a clean 409.
    // The exclusion constraint stays as the backstop.
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('hold:' || $1, 0))", [o.resource_id]);
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

/** Every bookingId ever quoted for the offer, newest first (expired ones included). */
export async function quotedBookingIds(db: Db, offerId: string): Promise<string[]> {
  const r = await db.query("SELECT booking_id FROM quotes WHERE offer_id = $1 ORDER BY created_at DESC", [offerId]);
  return r.rows.map((x: { booking_id: string }) => x.booking_id);
}

/**
 * Records a signed quote and extends the offer's hold to cover the quote's lifetime. Serialised per
 * offer with a row lock so two concurrent prepares cannot both issue a live quote.
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
    /** The hold outlives the quote by this much, so a deposit made just before expiry is indexed
     * into calendar_blocks before the slot can be offered again (docs/adr/0012 §3). */
    holdUntil: Date;
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
    await c.query("UPDATE holds SET expires_at = GREATEST(expires_at, $2) WHERE offer_id = $1", [q.offerId, q.holdUntil]);
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
  };
}
