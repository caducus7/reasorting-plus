# C7: iCal channel sync

**Read first:** `CLAUDE.md`; `docs/chain-spec.md` sections 5.2, 9, 10.2, 10.4 (INV-3);
`docs/handoffs/C6.md`.
**Depends on:** C6 calendar projection and head events.

## Goal

Import external channel calendars into the calendar projection and export our escrowed bookings as
iCal feeds, per resource, with conflict detection.

## In scope

- `services/apps/ical-sync/`.
- **Import:** per resource, a configurable list of channel feed URLs (Booking.com, Airbnb, others).
  Poll every 5 minutes with ETag and If-Modified-Since, parse RFC 5545 (including all-day events,
  TZID and floating times), upsert blocks into the calendar projection keyed by channel and UID,
  and delete blocks removed from the feed.
- **Staleness:** record last successful import per feed. Expose a staleness signal that C5's prepare
  uses to fail closed.
- **Export:** one unguessable-URL feed per resource and channel, containing our bookings once their
  deposit reaches the `safe` head, removed on cancellation. No guest names, emails or addresses in
  the feed: summary "Reserved" only.
- **Conflicts:** when an imported block overlaps an `ESCROWED` booking, raise INV-3 through C6's
  notifier with both booking references. Log every conflict with timestamps.

## Out of scope

Channel manager APIs (post-MVP). Deciding which booking to honour (the owner does, via
`cancelByProperty`).

## Write these tests first

1. Parser fixtures from real exported feeds (Booking.com and Airbnb samples, anonymised) including
   DST-crossing stays in Europe/Athens.
2. A reorg removing a deposit before `safe` never appears in the export; after `safe`, a removal
   deletes it on the next export.
3. A forced overlap raises exactly one INV-3 alert per conflict, not one per poll.

## Acceptance

- Milestone I3: a round trip with a real listing on one external channel, and a forced conflict
  triggers the alert.
- Feed fetch failures back off and surface staleness; they never delete existing blocks.

## Watch for

- Channels treat check-out day differently (exclusive DTEND for all-day events). Normalise to
  nights and test it.
- Treat every fetched feed as untrusted input: size limits, timeouts, no following redirects to
  private IP ranges.

## Handoff

`docs/handoffs/C7.md`, with the feed URL format and how the owner adds a channel.
