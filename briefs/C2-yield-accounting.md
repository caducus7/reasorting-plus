# C2: Yield accounting, deployment caps, loss handling, reserve

**Read first:** `CLAUDE.md`; `docs/chain-spec.md` sections 4.4, 4.5, 6.1 to 6.5, 10.4 and 13;
`docs/handoffs/C1.md`.
**Depends on:** C1 types and hooks.

## Goal

Fill C1's `_accrue()` and `_crystalliseYield()` hooks with the accumulator. Add `deploy`, `redeem`,
loss recognition and the `lossDebt` state, `topUpLoss`, and the owner-funded reserve.

## In scope

- Accumulator exactly as spec 6.1: `accYieldPerUnit` scaled 1e18, `accAtDeposit` per booking,
  `lastAssets` updated on every flow, gains with no open principal to `reserve`.
- Booking yield `y = principal * (acc - accAtDeposit) / 1e18` at settlement, fed into C1's
  settlement function.
- Deferral: while `lossDebt > 0`, settlement yield credits go to `totalPendingYield`, released in
  order when the debt reaches zero. Specify and document the release mechanism (lazy per booking on
  claim, or a permissionless `releasePendingYield(bookingIds[])`) in an ADR.
- `deploy` and `redeem` (`onlyRebalancer`) with the three on-chain caps in spec 6.3.
- Loss recognition with `LOSS_CONFIRMATION_WINDOW`: a permissionless `recogniseLoss()` that
  succeeds only if the shortfall has persisted for the window. Record the first-observed timestamp
  in a permissionless `observeShortfall()`, and clear it if assets recover.
- Absorption order: `reserve`, then owner payout `claimable`, then `lossDebt` (spec 6.4).
- `topUpLoss(amount)`, `fundReserve(amount)`, and reserve withdrawal requiring both owner and
  guardian (two-step: owner proposes, guardian confirms).
- Events `YieldAccrued`, `LossRecognised`, `LossRepaid`, `LossToppedUp`, `ReserveFunded`,
  `ReserveWithdrawn`.

## Out of scope

Adapters other than using `NullAdapter` and a test double (C4). Rebalancer logic (C8). Disputes
(C3), except that `totalDisputed` and `totalPendingYield` must exist for C3 to use.

## Write these tests first

1. Yield conservation (INV-4): total yield credited plus pending never exceeds total realised gain,
   under fuzzed deposits, settles, cancels and gains.
2. Fairness: two bookings with equal principal open over the same interval receive equal yield,
   within 1 atomic unit per accrual.
3. No retroactive yield: a booking deposited after a gain receives none of it.
4. Guest principal priority: under any injected loss, guest claims are served before owner and fee
   claims, and no guest credit is ever reduced.
5. Loss round trip: loss, then `lossDebt`, then partial gain repayment, then top-up, then normal
   distribution resumes, and every figure reconciles.

## Acceptance

- Use a test adapter that can inject gains, losses and withdrawal limits.
- `deploy` reverts on each violated cap with its own error.
- Transient dips shorter than the confirmation window never become `lossDebt`.
- While `lossDebt > 0`: deposits, owner and fee claims, and deploys revert; guest claims succeed from
  idle and then the adapter.
- Precision check: a 1 atomic unit gain over 10M USDC of principal doesn't overflow or silently
  zero out without being accounted as unallocated dust.

## Watch for

- The accumulator must never be share-priced. Principal is nominal.
- `lastAssets` drift is the classic bug here: every inflow and outflow, including reserve and
  top-ups, must update it by the exact amount.
- `recogniseLoss` must not be callable to grief (for example to block deposits on a 1-unit
  rounding blip). Consider a minimum loss threshold and record it in an ADR.

## Handoff

`docs/handoffs/C2.md`, with the ADRs for pending yield release and the loss threshold.
