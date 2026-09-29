# Operations runbook

## Indexer (C6)

Design: [ADR 0014](../docs/adr/0014-indexing-framework.md), [ADR 0017](../docs/adr/0017-indexer-design.md).
Environment: `services/apps/indexer/.env.example`.

### Processes

| Process | Command (in `services/apps/indexer`) | Notes |
|---|---|---|
| Ponder | `pnpm start` | `ponder start --schema $PONDER_LIVE_SCHEMA --views-schema $PONDER_SCHEMA`; serves the read API |
| Worker | `pnpm build && pnpm worker` | head tracker, milestones, calendar rows, monitors |
| Nightly replay | `pnpm build && pnpm replay` | cron, once a day; exit code 1 on a difference |

Consumers read Ponder's tables through the **views schema** (`indexer` by default), never through the
live schema, so a replay can be cut over without them noticing.

### Alerts

Alerts are written to `indexer_ops.alerts` and sent to the configured notifier. Each row's
`response` column is spec 10.4's response.

| Alert | First step |
|---|---|
| `INV-1` | Guardian pauses deposits (`pauseDeposits`). Halt deployment. Page the owner. |
| `INV-2` | Loss handling (spec 6.4): watch `ShortfallObserved`; after the window, `recogniseLoss`; the owner tops up. Halt deployment. |
| `INV-3` | Owner alert; follow the conflict runbook (spec 9). |
| `INV-4`, `INV-6`, `DIVERGENCE`, `RECONCILE` | Page. Halt deployment and new deposits. Compare the projection with the chain at the block in the alert. Run a replay (below) to see whether the projection or the contract is wrong. |
| `INV-5` | The rebalancer redeems. Halt deployment. |
| `LAG` | Check the Ponder log. If it says `Encountered unrecoverable reorg`, follow **Deep reorg** below. Otherwise check RPC health and rate limits. |
| `DEEP_REORG` | Follow **Deep reorg** below. |
| `REPLAY` | The nightly replay differs from production; the replay schema is kept. Treat it as `RECONCILE`. |
| `CALENDAR` | A booking for a resource with no configured time zone. Fix the properties file; the slot is blocked in UTC meanwhile. |

### Deep reorg (ADR 0014 gap 2, ADR 0017 §4)

On a reorg beyond Ponder's window, Ponder stops indexing at once but keeps retrying for up to
10 minutes before it exits. Calendar slots of deposits that had reached `safe` stay blocked
throughout.

1. Stop the live Ponder process.
2. Start a new one on a **new** schema with the same views schema:
   `ponder start --schema live_<n+1> --views-schema indexer`.
   It replays from the factory's start block, and Ponder switches the views once it is ready.
3. Watch the worker: `LAG` and `RECONCILE` resolve by themselves.
4. Deposits reported as `reverted` after `safe` (`DEEP_REORG:booking:*`) keep their calendar slot.
   For each one, contact the guest and the owner; the booking no longer exists on-chain.
5. Drop the old schema once the incident is closed. Set `PONDER_LIVE_SCHEMA` to the new name so
   the nightly replay compares against it.

### Nightly replay (spec 10.3)

`pnpm replay` builds `replay_<timestamp>` from scratch and diffs it with `$PONDER_LIVE_SCHEMA` up to
their common block.
- **Clean:** the schema is dropped and the command exits 0.
- **Different:** it opens a `REPLAY` page and keeps the schema.

Never edit projection tables by hand. The fix is always a replay.

## Channel sync (C7)

Design: [ADR 0018](../docs/adr/0018-ical-channel-sync.md). Service: `services/apps/ical-sync`
(`pnpm build && pnpm start`). It runs against the indexer's database.

### Adding a channel to a property

1. In the channel's calendar-sync settings, copy its **export** iCal URL. Menu names vary by
   channel and change over time; look for "sync calendars" or "export calendar".
2. Add an entry to `FEEDS_FILE`:
   `{ "feedId": "<channel>-<property>", "resourceId": "0x…", "channel": "<channel>", "url": "<that URL>" }`.
   The file is secret; never commit it.
3. Restart ical-sync. It prints this property's **export** URL for the channel, one line per
   `export <channel> <resourceId>`.
4. Paste that export URL into the channel's **import** calendar setting.
5. Until the first import succeeds, prepare fails closed for the property. That is expected.

Removing an entry and restarting deletes that feed's blocks.

### Alerts

| Alert | First step |
|---|---|
| `FEED_STALE` | Check the feed URL still works (channels rotate them), check `ical_sync.feed_state.last_error`. Prepare is failing closed for that property meanwhile. |
| `INV-3` overlap | The owner decides which booking to honour (spec 9 conflict runbook). If ours goes, `cancelByProperty`. Every conflict is in `ical_sync.conflicts`. |
| `CALENDAR` (from C6) | The property has no time zone in `PROPERTIES_FILE`. |

### Rotating export URLs

Change `EXPORT_TOKEN_SECRET` and restart, then paste the newly printed URLs into each channel. The
old URLs stop working at once.

## Rebalancer (C8)

Design: [ADR 0019](../docs/adr/0019-rebalancer-price-and-execution.md). Service:
`services/apps/rebalancer` (`pnpm build && pnpm start`), against the indexer's database.

- **It starts in dry run.** It decides and logs every cycle without sending. Review
  `rebalancer.decisions` (the full inputs, checks, decision and outcome of every cycle). Switch to
  `DRY_RUN=false` only when the owner decides to.
- **The key** must be each escrow's `rebalancer` (`setRebalancer` by the owner). It is a KMS key in
  every deployed environment.
- **Only one process per escrow.** A second one exits with "another rebalancer is running".

| Log outcome / reason | Meaning / first step |
|---|---|
| `hold` `price_stale`, `price_unavailable`, `price_out_of_band` | Deployment paused on the USDC price or the sequencer. Nothing to do; it never redeems because of price. |
| `hold` `cannot_redeem` (alert) | Funds are needed but the vault pays nothing now (paused wrapper, crunch). Watch C6's INV-5; the guest's claim still pays idle first. |
| `redeem` `liquidity_exit` | Market liquidity fell below 5x our position; everything withdrawable came back. |
| `precheck_reverted`, `reverted` | The move would fail or failed on-chain; that decision cools down (10 min, doubling to 6 h). Read `detail` for the custom error. |
| `nonce_consumed` | Another transaction used this key's nonce. Check nothing else signs with the rebalancer key. |
| `hold` `projection_lagging` | The indexer is behind: see C6's `LAG` alert. |
