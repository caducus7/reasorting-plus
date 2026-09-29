// Channel import (brief C7): poll each configured feed with conditional GET, parse, and make the
// feed's rows in calendar_blocks exactly the feed's current events (upsert by channel feed + UID,
// delete what left the feed) in one transaction. A failure of any kind changes no block: it backs
// off, and staleness surfaces to C5 (channel_feeds.last_success_at, which prepare fails closed on)
// and as an alert. After each import, overlaps with escrowed bookings raise INV-3 through C6's alert
// outbox: its dedupe gives one alert per conflict however many polls see it.
import type pg from "pg";
import { AlertOutbox, type Notifier } from "@chain/indexer/alerts";
import { inv3, type Breach } from "@chain/indexer/invariants";
import { localStay } from "@chain/indexer/calendar";
import { DateTime } from "luxon";
import { fetchFeed, type FetchOptions } from "./fetch.js";
import { parseFeed } from "./parse.js";

export type Feed = { feedId: string; resourceId: string; channel: string; url: string };
export type Escrowed = { escrow: string; bookingId: string; resourceId: string; checkInUtc: bigint; checkOutUtc: bigint };
/** ESCROWED bookings whose stay has not ended (C6's projection in production). */
export type EscrowedSource = (resourceId: string, now: Date) => Promise<Escrowed[]>;

export type SyncDeps = {
  pool: pg.Pool;
  chainId: number;
  feeds: Feed[];
  zones: Map<string, string>; // resourceId -> IANA zone
  escrowed: EscrowedSource;
  notifiers: Notifier[];
  now?: () => Date;
  fetchOptions?: FetchOptions;
  pollIntervalSec?: number; // spec 9: 5 minutes
  maxBackoffSec?: number;
  staleAlertSec?: number; // align with C5's FEED_MAX_AGE_SEC
  jitter?: () => number; // multiplier around 1 (default 0.9..1.1)
  massRemoval?: MassRemovalPolicy;
};

/** Review 0006 G1. An import that would remove at least `minCount` future blocks and more than
 * `fraction` of them, or that empties the feed of events while future blocks exist, holds those
 * removals until approved (Entra Connect's accidental-delete threshold, adapted: see ADR 0018). */
export type MassRemovalPolicy = { minCount: number; fraction: number };
export const MASS_REMOVAL_DEFAULTS: MassRemovalPolicy = { minCount: 2, fraction: 0.5 };

/** Which removed future blocks to hold. Pure; `priorFuture` counts the feed's stored future blocks. */
export function heldRemovals(p: { removedFuture: string[]; approved: string[]; priorFuture: number; feedEmpty: boolean }, policy = MASS_REMOVAL_DEFAULTS): string[] {
  const approved = new Set(p.approved);
  const unapproved = p.removedFuture.filter((r) => !approved.has(r));
  if (unapproved.length === 0) return [];
  const base = p.priorFuture - (p.removedFuture.length - unapproved.length); // approved ones are no longer in question
  const mass = unapproved.length >= policy.minCount && unapproved.length > policy.fraction * base;
  return mass || p.feedEmpty ? unapproved : [];
}

const lc = (s: string) => s.toLowerCase();

export function createSync(d: SyncDeps) {
  const now = d.now ?? (() => new Date());
  const interval = d.pollIntervalSec ?? 300;
  const maxBackoff = d.maxBackoffSec ?? 3_600;
  const jitter = d.jitter ?? (() => 0.9 + Math.random() * 0.2);
  const outbox = new AlertOutbox(d.pool, d.chainId, d.notifiers);
  const tzOf = (r: string) => d.zones.get(lc(r));
  const massKey = (feedId: string) => `FEED_MASS_REMOVAL:${feedId}`;

  /** Registers configured feeds (never-imported = stale for C5) and removes unconfigured ones. */
  async function syncConfig() {
    const c = await d.pool.connect();
    try {
      await c.query("BEGIN");
      const ids = d.feeds.map((f) => f.feedId);
      const gone = (await c.query("SELECT feed_id FROM ical_sync.feed_state WHERE NOT (feed_id = ANY($1::text[]))", [ids])).rows.map((r) => r.feed_id as string);
      for (const id of gone) {
        await c.query("DELETE FROM calendar_blocks WHERE source = $1", [id]);
        await c.query("DELETE FROM channel_feeds WHERE feed_id = $1", [id]);
        await c.query("DELETE FROM ical_sync.feed_state WHERE feed_id = $1", [id]);
      }
      for (const f of d.feeds) {
        await c.query("INSERT INTO channel_feeds (resource_id, feed_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [lc(f.resourceId), f.feedId]);
        await c.query(
          "INSERT INTO ical_sync.feed_state (feed_id, resource_id, next_attempt_at) VALUES ($1, $2, $3) ON CONFLICT (feed_id) DO UPDATE SET resource_id = EXCLUDED.resource_id",
          [f.feedId, lc(f.resourceId), now()],
        );
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  async function fail(f: Feed, failures: number, t: Date, status: string, err: string) {
    const back = Math.min(interval * 2 ** failures, maxBackoff) * jitter(); // 5, 10, 20 ... min
    await d.pool.query(
      `UPDATE ical_sync.feed_state SET failures = $2, next_attempt_at = $3, last_attempt_at = $4, last_status = $5, last_error = $6 WHERE feed_id = $1`,
      [f.feedId, failures + 1, new Date(t.getTime() + Math.round(Math.min(back, maxBackoff) * 1000)), t, status, err.slice(0, 500)],
    );
    console.warn(JSON.stringify({ at: t.toISOString(), feed: f.feedId, status, error: err, failures: failures + 1 }));
  }

  async function pollOne(f: Feed, st: { failures: number; etag: string | null; last_modified: string | null }) {
    const t = now();
    const tz = tzOf(f.resourceId);
    if (!tz) return fail(f, st.failures, t, "config", `resource ${f.resourceId} has no time zone`);
    let r;
    try {
      r = await fetchFeed(f.url, { ...d.fetchOptions, etag: st.etag, lastModified: st.last_modified });
    } catch (e) {
      return fail(f, st.failures, t, "fetch", (e as Error).message);
    }
    const ok = async (c: pg.PoolClient | pg.Pool, status: string, etag: string | null, lastModified: string | null, warnings: string[]) => {
      await c.query("UPDATE channel_feeds SET last_success_at = $3 WHERE resource_id = $1 AND feed_id = $2", [lc(f.resourceId), f.feedId, t]);
      await c.query(
        `UPDATE ical_sync.feed_state SET failures = 0, next_attempt_at = $2, last_attempt_at = $3, last_status = $4, last_error = NULL,
           etag = coalesce($5, etag), last_modified = coalesce($6, last_modified), last_warnings = $7 WHERE feed_id = $1`,
        [f.feedId, new Date(t.getTime() + Math.round(interval * jitter() * 1000)), t, status, etag, lastModified, warnings],
      );
    };
    if (r.status === 304) {
      await ok(d.pool, "304", null, null, []);
      return;
    }
    let parsed;
    try {
      parsed = parseFeed(r.body, { tz, now: t });
    } catch (e) {
      return fail(f, st.failures, t, "parse", (e as Error).message);
    }
    const c = await d.pool.connect();
    let held: string[] = [];
    let priorFuture = 0;
    try {
      await c.query("BEGIN");
      const refs = parsed.blocks.map((b) => b.ref);
      // Future = checkout after today in the property's zone: a current stay counts.
      const today = DateTime.fromJSDate(t).setZone(tz).toISODate()!;
      const stored = (
        await c.query("SELECT ref, upper(stay) > $3::date AS future FROM calendar_blocks WHERE resource_id = $1 AND source = $2 FOR UPDATE", [lc(f.resourceId), f.feedId, today])
      ).rows as { ref: string; future: boolean }[];
      const approved = ((await c.query("SELECT approved_removals FROM ical_sync.feed_state WHERE feed_id = $1 FOR UPDATE", [f.feedId])).rows[0]?.approved_removals ?? []) as string[];
      const inFeed = new Set(refs);
      priorFuture = stored.filter((b) => b.future).length;
      held = heldRemovals(
        { removedFuture: stored.filter((b) => b.future && !inFeed.has(b.ref)).map((b) => b.ref), approved, priorFuture, feedEmpty: parsed.blocks.length === 0 },
        d.massRemoval,
      );
      await c.query("DELETE FROM calendar_blocks WHERE resource_id = $1 AND source = $2 AND NOT (ref = ANY($3::text[]))", [lc(f.resourceId), f.feedId, [...refs, ...held]]);
      await c.query("UPDATE ical_sync.feed_state SET held_removals = $2, approved_removals = '{}' WHERE feed_id = $1", [f.feedId, held]);
      for (const b of parsed.blocks) {
        await c.query(
          `INSERT INTO calendar_blocks (resource_id, stay, source, ref) VALUES ($1, daterange($2::date, $3::date), $4, $5)
           ON CONFLICT (resource_id, source, ref) DO UPDATE SET stay = EXCLUDED.stay`,
          [lc(f.resourceId), b.from, b.to, f.feedId, b.ref],
        );
      }
      await ok(c, "200", r.etag, r.lastModified, parsed.warnings);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      return fail(f, st.failures, t, "store", (e as Error).message);
    } finally {
      c.release();
    }
    // Held blocks stay in calendar_blocks, so the import still counts as a success (the stored set is
    // a superset of the feed: no date reopens) and C5 keeps quoting the rest of the calendar.
    if (held.length === 0) return outbox.resolve([massKey(f.feedId)]);
    console.warn(JSON.stringify({ at: t.toISOString(), feed: f.feedId, heldRemovals: held.length, priorFutureBlocks: priorFuture }));
    await outbox.open([
      {
        invariant: "FEED_MASS_REMOVAL",
        severity: "alert",
        key: massKey(f.feedId),
        message: `channel feed ${f.feedId} (${lc(f.resourceId)}) dropped ${held.length} of ${priorFuture} future blocks at once: kept blocked until the owner confirms on the channel and runs \`pnpm confirm-removals ${f.feedId}\``,
        details: { held: held.length, priorFuture },
        response: ["check_channel_feed", "confirm_removals"],
      },
    ]);
  }

  /** Polls every feed whose next attempt is due, then checks every configured resource for
   * conflicts. Level-triggered (review 0005 R4): a new escrow booking can overlap a channel block
   * whose feed has not changed (304), so conflicts are re-evaluated every cycle, not only on import. */
  async function pollDue() {
    const due = (await d.pool.query("SELECT feed_id, failures, etag, last_modified FROM ical_sync.feed_state WHERE next_attempt_at <= $1", [now()])).rows;
    for (const row of due) {
      const f = d.feeds.find((x) => x.feedId === row.feed_id);
      if (f) await pollOne(f, row);
    }
    for (const r of new Set(d.feeds.map((f) => lc(f.resourceId)))) await checkConflicts(r);
  }

  /** INV-3 overlaps for one resource: log, alert once per conflict, resolve what cleared. */
  async function checkConflicts(resourceId: string) {
    const t = now();
    const tz = tzOf(resourceId) ?? "UTC";
    const bookings = (await d.escrowed(lc(resourceId), t)).map((b) => ({
      escrow: b.escrow,
      bookingId: lc(b.bookingId),
      resourceId: lc(b.resourceId),
      ...localStay(b, tz),
    }));
    const rows = (
      await d.pool.query("SELECT resource_id, source, ref, lower(stay)::text AS f, upper(stay)::text AS t FROM calendar_blocks WHERE resource_id = $1 AND source <> 'escrow'", [lc(resourceId)])
    ).rows.map((r) => ({ resourceId: r.resource_id as string, source: r.source as string, ref: r.ref as string, from: r.f as string, to: r.t as string }));
    const overlaps = inv3(bookings, rows).filter((b: Breach) => b.key.startsWith("INV-3:overlap:"));
    const current = new Set(overlaps.map((b) => b.key));
    for (const b of overlaps) {
      const [, , bookingId, source, ...refParts] = b.key.split(":");
      const ref = refParts.join(":");
      const bk = bookings.find((x) => x.bookingId === bookingId)!;
      const blk = rows.find((x) => x.source === source && x.ref === ref)!;
      const upd = await d.pool.query("UPDATE ical_sync.conflicts SET last_seen_at = $2 WHERE alert_key = $1 AND resolved_at IS NULL", [b.key, t]);
      if (!upd.rowCount) {
        await d.pool.query(
          `INSERT INTO ical_sync.conflicts (resource_id, escrow, booking_id, source, ref, booking_stay, block_stay, alert_key, first_seen_at, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, daterange($6::date, $7::date), daterange($8::date, $9::date), $10, $11, $11)`,
          [lc(resourceId), lc(bk.escrow), bookingId, source, ref, bk.from, bk.to, blk.from, blk.to, b.key, t],
        );
        console.error(JSON.stringify({ at: t.toISOString(), conflict: b.key, booking: [bk.from, bk.to], channelBlock: [blk.from, blk.to] }));
      }
    }
    await outbox.open(overlaps);
    const cleared = (
      await d.pool.query("SELECT alert_key FROM ical_sync.conflicts WHERE resource_id = $1 AND resolved_at IS NULL", [lc(resourceId)])
    ).rows.map((r) => r.alert_key as string).filter((k) => !current.has(k));
    if (cleared.length) {
      await d.pool.query("UPDATE ical_sync.conflicts SET resolved_at = $2 WHERE alert_key = ANY($1::text[]) AND resolved_at IS NULL", [cleared, t]);
      await outbox.resolve(cleared);
    }
  }

  /** One FEED_STALE alert per feed past the staleness threshold; resolved when it imports again. */
  async function checkStaleness() {
    const t = now();
    const stale = (
      await d.pool.query(
        `SELECT cf.feed_id, cf.resource_id, cf.last_success_at, fs.last_error FROM channel_feeds cf
           LEFT JOIN ical_sync.feed_state fs USING (feed_id)
          WHERE cf.last_success_at IS NULL OR cf.last_success_at < $1::timestamptz - make_interval(secs => $2)`,
        [t, d.staleAlertSec ?? 900],
      )
    ).rows;
    await outbox.sync(
      "FEED_STALE",
      stale.map((r) => ({
        invariant: "FEED_STALE",
        severity: "alert" as const,
        key: `FEED_STALE:${r.feed_id}`,
        message: `channel feed ${r.feed_id} (${r.resource_id}) has not imported since ${r.last_success_at?.toISOString?.() ?? "never"}: prepare fails closed for this resource`,
        details: { lastError: r.last_error ?? null },
        response: ["check_channel_feed"],
      })),
    );
  }

  return { syncConfig, pollDue, checkConflicts, checkStaleness, outbox };
}
