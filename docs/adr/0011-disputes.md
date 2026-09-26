# 0011: disputes (C3)

**Status:** Accepted with C3 (the project owner said to go with defaults). §3 departs from the
brief's recommended default, which the brief leaves to C3 to decide; the reasoning is below.
**Touches:** `IEscrow` (functions, `Dispute` struct, `DisputeReason` enum, errors, `DisputeOpened`
signature) and Escrow storage (`_disputes` appended).

## 1. Mechanics (spec 7)

- `openDispute(bookingId, contested, evidenceHash)` requires:
  - the caller is the guest (D8)
  - stored state is ESCROWED (not frozen, settled or disputed)
  - `checkOut <= now < checkOut + GRACE`
  - `0 < contested <= principal`
- In one step, `openDispute` crystallises the booking's yield `y` into `totalPendingYield`, removes
  the principal from `totalOpenPrincipal`, moves `contested` into `totalDisputed`, and settles the
  uncontested remainder as a delivered stay (refund 0, fee on it, owner bucket). State becomes
  DISPUTED.
- `resolve(bookingId, guestBps, reasonCode)` is callable only by the arbitrator **snapshotted on
  the booking**. It applies `SettlementLib.compute` to the contested amount: the guest refund rounds
  up, the fee is taken from what the owner retains, and yield vests only if `guestBps == 0` (D3).
  Credits go to the stored guest, the owner bucket and the fee recipient read at resolution. There
  is no recipient parameter.
- While `lossDebt > 0`, resolution credits principal normally and defers the yield
  (`YieldDeferred`), exactly as settlement does (ADR 0010).
- `resolveByDefault(bookingId)` is permissionless from `disputeDeadline`. It resolves with
  `guestBps = 0` and `reasonCode = DEFAULT_TIMEOUT`.
- The whole booking meets spec 4.4 across the two settlements:
  `refund + ownerPrin_u + ownerPrin_c + fee_u + fee_c == principal`, `guestY + ownerY == y`, and
  each fee is at most its retained part (fuzzed, `testFuzz_conservationAcrossSplit`).

## 2. `reasonCode` enum

`DisputeReason`:

| Code | Value |
|---|---|
| 0 | `NOT_AS_DESCRIBED` |
| 1 | `ACCESS_OR_CHECK_IN_FAILURE` |
| 2 | `CLEANLINESS_OR_MAINTENANCE` |
| 3 | `SAFETY_OR_HEALTH` |
| 4 | `AMENITY_MISSING` |
| 5 | `BILLING_ERROR` |
| 6 | `OTHER` |
| 7 | `DEFAULT_TIMEOUT` (reserved: only `resolveByDefault` emits it; `resolve` rejects it) |

Any other value reverts `InvalidReasonCode`. Adding a reason means a new implementation.

## 3. Frozen time **extends** the dispute deadline

`disputeDeadline = openedAt + DISPUTE_WINDOW + (frozen time accumulated after opening)`. Freezes
before the dispute do not count.

**Why not the brief's recommendation ("does not extend, matching GRACE"):** the freeze budget is
30 days, longer than the 14-day window. If the window kept running while the booking was frozen, the
guardian could freeze a dispute until it expired. On unfreeze, anyone, including the owner, could
immediately `resolveByDefault` for `guestBps = 0`. A compromised guardian working with the owner
would then defeat every guest dispute, and the arbitrator would never have been able to act. The
window exists so an **unresponsive** arbitrator cannot strand funds, not so a **blocked** one loses
by default. Extending costs one snapshot per dispute, and total delay stays bounded by the freeze
budget. Tested in `test_freezeExtendsDisputeDeadline` and `test_freezeBeforeOpenDoesNotExtend`.

`GRACE` (the guest's window to *open* a dispute) is still not extended, per spec 3.5; see the C3
handoff's spec concerns.

## 4. Events

`DisputeOpened(bookingId, contestedAtomic, evidenceHash, uncontestedOwnerPrincipal, uncontestedFee,
y, feeRecipient)` now carries the uncontested settlement figures and `y`, so C6 can rebuild the
ledger without calls (CLAUDE.md rule 7). It replaces C1's three-field declaration.
`DisputeResolved` is unchanged. A disputed booking emits no `BookingSettled`; C6 treats
`DisputeResolved` as that booking's settlement (outcome `DISPUTE_RESOLVED`).

## 5. Structure

Accounting lives in the linked `DisputeLib` (2,303 B) over `Ledger`, `Booking` and `Dispute`
storage, following ADR 0010. The escrow keeps the role, state and time guards. Escrow is 20,732 B,
with 3,844 B of headroom left.
