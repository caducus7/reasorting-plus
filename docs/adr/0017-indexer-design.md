# 0017: indexer design (C6), and a correction to ADR 0014

**Status:** Accepted with C6. It builds on ADR 0014 (Ponder) and corrects one statement in it.
Everything below is tested; the tests are named in `docs/handoffs/C6.md`.

## 1. Where projection state lives

All projection state is in Ponder's own tables: `escrow`, `booking`, `balance`, `journal`,
`processed_event` and `anomaly` (`services/apps/indexer/ponder.schema.ts`). Ponder rolls these back
on a reorg.

A separate worker process holds only two kinds of data:
- **Observations:** the chain's heads.
- **Outboxes:** head events, booking milestones and alerts, in schema `indexer_ops`.

Both handlers and tests run the same pure reducer (`src/core/reducer.ts`). It mirrors
`LedgerLib`/`DisputeLib` posting by posting, and it keys idempotency on
`(chainId, txHash, logIndex)` (spec 10.1).

## 2. The shared `calendar_blocks` table is derived, not written by handlers

Ponder cannot roll back a table it does not own. A view over Ponder's tables would also break
Ponder's cutover: `createViews` runs `DROP VIEW` without `CASCADE` (`database/actions.ts:286`).

So the worker recomputes the `source = 'escrow'` rows from the projection on every tick. It does
this in one transaction under an advisory lock. The table is always a function of the projection
plus the milestones.

Two rules are added to the brief's "Decided" contract (ADR 0012 §3, §7), both in the safe
direction:

- **A cancellation frees a slot only once the cancellation is at the safe head.** A cancellation
  that could still be reorged away must not free a slot that another guest could then book.
- **A deposit that reached `safe` and is then reorged out keeps its slot, and pages.** This is the
  brief's test 1 ("the calendar slot frees only if it had not reached safe").

C5's contract is unchanged: a row exists means the booking was handed over.

## 3. Heads and milestones (spec 10.2)

The head tracker reads the chain's own `latest`, `safe` and `finalized` tags, with block hashes.
For each change it writes a row to `indexer_ops.head_events` and sends `NOTIFY chain_head`.

A deep reorg is detected when either:
- a safe or finalized head moves backwards, or
- the previous safe or finalized block is no longer canonical.

Either case pages (`DEEP_REORG`).

Each booking gets milestones in `indexer_ops.booking_milestones`, and each new one is announced
with `NOTIFY booking_milestone`. They map onto spec 10.2 as follows:

| Milestone | When | Spec 10.2 action |
|---|---|---|
| `received` | `latest >= depositBlock + 2` | "booking received" |
| `safe` | `safe >= depositBlock` and the deposit block's hash is still canonical | mark sold / iCal export (C7) |
| `finalized` | same, for the finalized tag | confirmation email (notifier) |
| `reverted` | a deposit that had a milestone has left the projection | pages if it had reached `safe` |

For "credit claimable balances" and "count funds as deployable", the ledger is read at the
finalized head: `GET /v1/indexer/escrows/:escrow/summary?head=finalized` sums the journal up to
the finalized block.

## 4. Correction to ADR 0014: how Ponder "halts"

ADR 0014 says an unrecoverable reorg is "detected, `Encountered unrecoverable reorg`, then
shutdown". Measured on Anvil with Ponder 0.17.12, what actually happens is:

- Ponder logs the warning.
- It stops indexing at once.
- It then retries for up to `MAX_LATEST_BLOCK_ATTEMPT_MS` (10 minutes, `sync-realtime/index.ts:103`)
  before it exits.

The process can therefore look alive while the projection is frozen. Three independent monitors
page in that state, and `test/anvil/reorg.test.ts` checks all three:

- **`LAG`:** the projection is more than `MAX_LAG_BLOCKS` behind `latest` (default 60 blocks, about
  2 minutes on Base).
- **`DEEP_REORG`:** from the head tracker.
- **`RECONCILE`:** the stale projection disagrees with the chain at its own checkpoint block.

The recovery is the ADR's full replay into a new schema. Ponder switches the views schema once the
replay is ready.

Two measured window sizes on Anvil:
- A 41-block reorg was inside Ponder's 30–60 block window, and Ponder rolled it back.
- A 91-block reorg was beyond the window, and Ponder stalled.

Ponder's `/status` endpoint reports the block it has *synced*, which can be ahead of the block it
has *indexed*. Consumers must use `_ponder_checkpoint.latest_checkpoint`: the worker's snapshot and
the test harness both do.

## 5. Ledger chart of accounts

**Asset accounts:** `idle`, `deployed` and `loss_debt`.

**Liability accounts:** `open_principal`, `disputed`, `pending:{dispute,guest,owner}`,
`claimable:{guest,fee,owner}`, `reserve` and `yield_unallocated`.

Every event posts balanced legs. The contract's books identity holds after every event:
`idle + deployed + loss_debt == Σ liabilities`, and `idle + deployed == lastAssets`.

`idle` and `deployed` are a book split. Gains and recognised losses are booked to `deployed`, because
neither the contract nor its events can tell vault growth from a direct transfer to the escrow. The
real idle balance comes from chain reads (INV-5).

## 6. Invariant monitors (spec 10.4)

Each invariant is a pure function (`src/core/invariants.ts`) that feeds an alert outbox and a
pluggable `Notifier`. The projection-side checks run every tick. The chain-read checks run on a
schedule, at exactly the block the projection snapshot is complete up to.

| Check | Severity | Band |
|---|---|---|
| INV-1 | page | page at a gap >= `MIN_LOSS_ATOMIC` (ADR 0013 §4) |
| INV-2 | alert at >= `MIN_LOSS_ATOMIC`, warn below | ERC-4626 rounding |
| INV-3 | alert | missing escrow row, or a channel event overlapping an ESCROWED stay; the iCal-export half is C7's |
| INV-4 | page | Σ crystallised y ≤ Σ gains credited to the accumulator |
| INV-5 | alert | idle ≥ max(must-stay-liquid, `MIN_BUFFER_BPS` floor) (spec 6.7) |
| INV-6 | page | recorded by the reducer as an anomaly per settlement event |
| RECONCILE | page | every ledger field vs the contract at the same block |
| LAG, DEEP_REORG, REPLAY | page | §4 and §7 |

Alerts carry the spec 10.4 response in `response`, for example `guardian_pause_deposits` and
`halt_deployment`. The indexer never acts on those responses itself; the rebalancer (C8) and
people act on them.

## 7. Replay diff (spec 10.3)

`runReplay` starts `ponder start` into a new schema and waits until it reaches production's
checkpoint. It then diffs the two schemas up to the common block:

- **Journal, processed events and anomalies:** immutable facts per block. They must match exactly.
- **Booking and escrow rows:** compared only where neither side changed them after that block.
- **Internal consistency:** each schema's `balance` table must equal the sum of its own journal.

A clean diff drops the replay schema. A difference pages and keeps the schema for forensics. The
deep-reorg recovery in §4 uses the same machinery.

## 8. Read API (not the `/v1` Service API)

Ponder's HTTP server exposes three routes:
- `/v1/indexer/bookings/:escrow/:bookingId`
- `/v1/indexer/escrows/:escrow/summary[?head=latest|safe|finalized]`
- `/v1/indexer/escrows/:escrow/accounts/:account`

Money values are decimal strings.

The booking view mirrors the contract's own views: `bookingState` via `_bookingNow`, then
`refundBpsNow` and `claimableOf`. The refund comes from C5's reference evaluator in
`@chain/shared`.

Spec 5.3 is unchanged. C5 keeps serving `/v1/bookings/{id}` and can swap its interim chain read
model for this API behind `BookingReadModel`. That change is C5's to make.
