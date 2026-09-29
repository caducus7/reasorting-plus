# 0018: iCal channel sync (C7)

**Status:** Accepted with C7. It builds on ADR 0017 (calendar rows, head milestones, alert outbox).
Tests are named in `docs/handoffs/C7.md`.

## 1. Libraries, not a hand-written parser

| Library | Used for | Why |
|---|---|---|
| **ical.js 2.2.1** (Mozilla, MPL-2.0) | parsing and export | The RFC 5545 engine behind Thunderbird: VTIMEZONE, RRULE/EXDATE/RECURRENCE-ID, line folding, escaping. One library for both directions. |
| **undici 8.11.2** | HTTP client | Node's own. Lets the DNS lookup be replaced at connect time. |
| **ipaddr.js 2.5.0** | address ranges | Classifies private, reserved and public ranges. |

`node-ical` and `ical-generator` were considered and rejected: two libraries where one covers both
directions.

## 2. Normalising to nights

Every event becomes property-local nights `[from, to)` with an exclusive end. That is how every
channel treats check-out day: an all-day `DTEND` is the check-out date. The rules:

- **All-day events:** the wall dates, unshifted by DST. A missing `DTEND` means one night.
- **Timed events:** converted to the property's zone, then `from` = the local date of the start
  and `to` = the local date of the end.
- **Same-day or inverted blocks** (e.g. maintenance 10:00–14:00): block that night.
- **Recurrences:** expanded up to 730 days ahead, capped at 1,000 occurrences each. Each occurrence
  gets its own ref, `UID#date`.
- **`STATUS:CANCELLED`:** ignored.
- **Events without a UID:** a stable content hash stands in as the ref.

Wherever the rules are ambiguous they block, never free.

**Time zones resolve per feed, in this order:**
1. UTC: exact.
2. A TZID that is an IANA name: tzdata.
3. Another TZID with a VTIMEZONE in the same feed: that definition.
4. Anything else: the property's own zone, with a warning.

ical.js's process-wide `TimezoneService` is never used. With it, one feed's VTIMEZONE could change
how another feed is read.

## 3. Untrusted feeds (OWASP SSRF guidance)

- https only in production, with no other scheme on redirects either.
- Only public unicast addresses, checked **at connect time** by a DNS lookup on the dispatcher, so
  DNS rebinding cannot swap in a private address after a check. IP-literal hosts are checked
  before connecting.
- IPv4-mapped IPv6 addresses are unwrapped before the check.
- At most 3 redirects, followed manually.
- A 15 s total timeout and a 5 MiB streamed body cap.
- No credentials in feed URLs.
- At most 5,000 events per feed.

## 4. Import and staleness

Each poll uses a conditional GET (`ETag` / `If-Modified-Since`). A successful parse replaces the
feed's rows in `calendar_blocks` in one transaction:
- the source is `feedId` and the ref is the UID;
- changed events are upserted;
- events that left the feed are deleted.

**Any failure changes no block:** a fetch error, an error status, a parse error or a store error.
Instead the feed backs off, `min(5 min × 2^failures, 60 min)` with ±10% jitter.

Staleness is surfaced in two ways:
- **For C5:** C7 owns `channel_feeds.last_success_at`, which C5's prepare already fails closed on
  (ADR 0012 §4). A configured feed is registered with `NULL` (never imported), so prepare fails
  closed until its first import.
- **For people:** a `FEED_STALE` alert after 900 s, the same value as C5's `FEED_MAX_AGE_SEC`.

### 4a. Mass-removal guard (amendment, review 0006 G1)

An empty or truncated export that still answers 200 would delete every block and reopen those dates.
Prior art:
- **Microsoft Entra Connect, "prevent accidental deletes":** on by default. An export that stages
  more deletes than a threshold (default 500) is stopped, and an admin approves it.
- **rsync / rclone `--max-delete`.**

Adapted to the asymmetry here, where a kept block costs a sale and a lost block risks a double
booking:
- **What is held:** an import that would remove at least `MASS_REMOVAL_MIN` (2) future blocks and
  more than `MASS_REMOVAL_FRACTION` (50%) of the feed's future blocks, or that leaves the feed with no
  events while future blocks exist. Only those removals are held; they stay in `calendar_blocks`
  (`ical_sync.feed_state.held_removals`).
- **What still applies:** additions, changes, and removals of past blocks. The stored set is then a
  superset of the feed, so the import counts as a success, `last_success_at` moves on, and C5 keeps
  quoting the rest of the calendar.
- **Signal and approval:**
  - A `FEED_MASS_REMOVAL:<feedId>` alert opens once.
  - `pnpm confirm-removals <feedId>` approves exactly the set held at that moment. A removal that
    grows afterwards is judged again.
  - Approving clears the conditional-GET validators, so the next poll re-imports rather than getting
    a 304.
- **Self-healing:** if the feed brings the events back, the hold clears and the alert resolves.
- **Future** means checkout after today in the property's zone, so a current stay counts.

**Known false positive:** a property whose only future booking is cancelled on a channel whose
export is then empty. It is held until confirmed, and the dates stay blocked, which is the safe side.

## 5. Conflicts (INV-3)

After each import, C7 checks the resource with **C6's own `inv3`** against the same set of bookings:
`ESCROWED`, with the stay not yet ended. The alert key is therefore the same whichever process sees
the conflict first, and C6's alert outbox dedupe gives **one alert per conflict**, however many polls
or processes observe it.

The alert carries both references (our bookingId, and the channel feed plus UID).
`ical_sync.conflicts` logs each conflict with `first_seen_at`, `last_seen_at` and `resolved_at`.
When the overlap clears, C7 resolves exactly that alert. To support this, C6's `AlertOutbox` gained
`open()` and `resolve(keys)`; the change is additive.

## 6. Export

`GET /ical/<token>.ics` serves one feed per resource and channel. The token is
`base64url(HMAC-SHA256(EXPORT_TOKEN_SECRET, "ical-export:v1:<resourceId>:<channel>"))`:
256 bits, stable, and rotated by rotating the secret. Tokens are compared in constant time, and
unknown or malformed tokens both return 404.

**What the feed contains:** our bookings whose deposit reached `safe` (spec 10.2), matched on
deposit block hash so that a re-mined deposit counts only once it is safe again.

**When a booking leaves the feed:**
- a deposit reorged out leaves on the next request;
- a cancellation leaves only once the cancellation itself is at `safe` (ADR 0017 §2).

**Events:** all-day, with `DTEND` = the check-out date and `SUMMARY:Reserved`.

**Privacy:** the UID is `HMAC(secret, bookingId)`, not the bookingId. The bookingId is public
on-chain, so it would link a channel's calendar to the guest's wallet.

**Caching:** the output is deterministic, with an ETag and 304s.

## 7. Configuration

- **`FEEDS_FILE`:** JSON `[{feedId, resourceId, channel, url}]`. It is secret, because channel
  import URLs carry the channel's own token, so it is gitignored with an example file alongside.
- **Adding or removing a channel:** edit the file and restart. A removed feed's blocks and its
  staleness row are deleted.
- **`PROPERTIES_FILE`:** the same file as C5 and C6, the source of time zones.
