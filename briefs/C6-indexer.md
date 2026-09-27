# C6: Indexer, projections, invariants, read API

**Read first:** `CLAUDE.md`; `docs/chain-spec.md` sections 4.7, 5.3, 6.1, 6.4, 9, 10, 14 (D6);
handoffs for C1 to C3.
**Depends on:** C1 to C3 ABIs and events.

## Goal

A reorg-safe indexer that rebuilds a double-entry ledger and a calendar projection purely from
events, monitors the invariants, and serves the read side of the Service API.

## In scope

- **Framework decision (D6):** evaluate Ponder and Envio against the four requirements in spec 10.1
  with a small prototype on Base Sepolia, including a forced reorg on a local Anvil chain. Write the
  ADR, then build on the winner. Build only the gaps it doesn't cover.
- **Head awareness:** expose `unsafe`, `safe` and `finalized` views; downstream actions wait on the
  head in spec 10.2. Publish head-transition events (for example a Postgres `LISTEN/NOTIFY` channel
  or an outbox table) that C7, C8 and the agent workstream's notifier consume.
- **Ledger projection:** double-entry accounts per escrow: guest claimable, owner claimable, fee
  claimable, open principal, disputed, pending yield, reserve, loss debt, idle, deployed. Every event
  posts balanced entries.
- **Calendar projection:** our bookings by state plus imported channel events (written by C7).
- **Replay:** nightly full rebuild into a separate schema, diffed against production; any
  difference alerts.
- **Invariant monitors:** INV-1 to INV-6 from spec 10.4, evaluated on every relevant event and on a
  schedule against chain reads. Alerts to a pluggable notifier interface (the agent workstream owns
  the messaging adapter).
- **Read API** used by C5: booking status, refund if cancelled now (via C5's reference evaluator,
  shared package), accrued yield per booking, escrow summary for the owner digest.

## Out of scope

iCal (C7), rebalancer (C8), the owner dashboard and digest UI (agent workstream).

## Write these tests first

1. **Reorg:** on Anvil, index, force a reorg that removes a deposit, and assert the booking and all
   its ledger entries roll back and the calendar slot frees only if it had not reached `safe`.
2. **Idempotency:** replaying the same logs twice produces identical projections.
3. **Ledger balance:** for any fuzzed event sequence from the C9 handlers, every account balances and
   ledger totals equal the contract's own accounting fields.

## Acceptance

- Replay diff clean on a Base Sepolia deployment with at least 50 mixed bookings, cancels, disputes
  and settlements.
- Each invariant has a test that breaks it deliberately and sees the alert.
- Read API latency under 100ms p95 locally.

## Decided (from C5, ADR 0012 §3 and §7)

- The calendar projection writes escrow bookings into the shared `calendar_blocks` table:
  - one row per booking, written at the unsafe head;
  - `source = 'escrow'`, `ref` = bookingId (lowercase `0x` hex), `resource_id` lowercase hex;
  - `stay` = the property-local `[checkIn, checkOut)` dates;
  - the row is removed on reorg rollback of the deposit and on cancellation.
- The quote service releases a quoted slot's hold only when this row exists and the deposit is at the
  safe head. There is no indexing-latency requirement.

## Watch for

- The projection must never hold state replay can't reproduce. No manual fixes in the DB.
- Timelocked config is a pure function of time: compute effective fee and fee recipient from
  proposal events and block timestamps, not from polling.
- Cursor on `(blockNumber, blockHash)`, never block number alone.

## Handoff

`docs/handoffs/C6.md`, with the framework ADR and the notifier interface definition.
