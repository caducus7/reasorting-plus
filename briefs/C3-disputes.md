# C3: Disputes

**Read first:** `CLAUDE.md`; `docs/chain-spec.md` sections 3.3, 3.5, 4.4, 7, 14 (D8, D9);
`docs/handoffs/C1.md` and `C2.md` if available.
**Depends on:** C1 types. Uses C2's `totalDisputed` and `totalPendingYield` (coordinate via the
interface if C2 isn't merged yet).

## Goal

`openDispute`, `resolve`, `resolveByDefault` with partial settlement, yield crystallisation at open,
and the D3 yield rule on resolution.

## In scope

- `openDispute(bookingId, contestedAtomic, evidenceHash)`: guest only (D8 default), booking
  `DELIVERED`, before `checkOut + GRACE`, `0 < contestedAtomic <= principal`.
- On open, in order: `accrue()`; crystallise booking yield into `totalPendingYield`; remove principal
  from `totalOpenPrincipal`; move `contestedAtomic` into `totalDisputed`; settle the uncontested
  remainder as a delivered stay with the fee applied.
- `resolve(bookingId, guestBps, reasonCode)`: only the arbitrator **snapshotted on that booking**;
  `guestBps <= 10_000`; `reasonCode` from a fixed enum.
- `resolveByDefault(bookingId)`: permissionless after `DISPUTE_WINDOW`, resolves with
  `guestBps = 0`.
- Resolution settlement: `guestBps` of contested to the guest (round up), the rest to the owner with
  the fee on the retained part; crystallised yield split per spec 4.4 (vested only if
  `guestBps == 0`).
- Events `DisputeOpened`, `DisputeResolved` with all figures.

## Out of scope

Damage deposits or owner-opened disputes (blocked on D8). Arbitrator rotation for existing bookings
(D9: none).

## Write these tests first

1. Conservation across the split: uncontested settlement plus resolution together satisfy the three
   equalities for the whole booking.
2. Blast radius: fuzzed arbitrator actions can move no funds except the contested amount of bookings
   whose snapshot names that arbitrator, and only to that booking's guest or payout address.
3. Snapshot: an arbitrator change proposed and effective after deposit cannot resolve that booking;
   the old arbitrator can.

## Acceptance

- Every guard has a revert test.
- A frozen booking cannot be disputed or resolved.
- `resolveByDefault` before the window reverts, after it succeeds for any caller.
- A dispute opened while `lossDebt > 0` defers yield correctly and still pays guest principal.

## Watch for

- `contestedAtomic` is part of what the owner would retain; the guest's refund on a delivered stay is
  zero, so the resolution refund comes only from the contested amount.
- Don't add a `to` parameter anywhere.

## Handoff

`docs/handoffs/C3.md`, including the `reasonCode` enum you chose.
