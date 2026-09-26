# C9: Independent invariant and adversarial suite

**Read first:** `CLAUDE.md`; `docs/chain-spec.md` **in full**.
**Depends on:** the published ABIs and interfaces from C1 to C3 (`contracts/src/interfaces/`).

## The rule for this package

**Don't read the implementation in `contracts/src/` other than the interfaces.** Don't read the
C1 to C3 handoffs or their tests until your suite is written and has been run once. Your value is
that you test the spec, not the code. If an interface is ambiguous, resolve it from the spec, and
record the ambiguity.

## Goal

A Foundry invariant suite with its own handlers that drives the real contracts through random,
valid sequences of guest, owner, guardian, arbitrator, rebalancer, factoryAdmin and attacker
actions, and checks the spec's properties after every step.

## In scope

- `contracts/test/invariant/independent/`: handlers, ghost accounting built from the spec's
  formulas (not from contract state), and invariant tests.
- A test adapter under your control that injects gains, losses and withdrawal limits.
- Time warps across cutoffs, check-in, check-out, `GRACE`, `DISPUTE_WINDOW`, timelock delays and
  the loss confirmation window.

## Properties to assert

1. Solvency INV-1 and full solvency INV-2 as written in spec 10.4.
2. Settlement equalities from spec 4.4 for every settled booking, checked against your ghost figures.
3. Guest refund and principal credits equal the spec formula, and are never reduced afterwards.
4. Yield conservation INV-4, and no booking receives yield accrued before its deposit.
5. Terms immutable after deposit.
6. No actor except the stored guest, payout address and fee recipient ever receives USDC from the
   escrow, and the adapter only from the escrow.
7. While `lossDebt > 0`: no deposit, deploy, owner claim or fee claim succeeds.
8. A quote whose `feeBps` or `guestYieldBps` doesn't equal the live value never deposits.
9. A compromised arbitrator (fuzzed calls) affects only contested amounts on bookings that
   snapshotted it.
10. A compromised rebalancer (fuzzed calls) can't reduce any account's total entitlement, only
    move funds between idle and adapter.
11. `settle` and `resolveByDefault` are always eventually callable (no stuck funds) for unfrozen
    bookings.

## Adversarial scenarios (targeted tests, not just fuzzing)

- Replay a signed quote on a different escrow and a different chain ID.
- Cancel in the same block as a cutoff boundary, at `checkIn`, and at `checkOut - 1`.
- Deposit with a quote signed just before a fee change becomes effective.
- Grief `depositWithPermit` by front-running the permit.
- Force a loss exactly at the confirmation window boundary.
- A guest address blacklisted by the token (use a mock token with a blacklist).

## Acceptance

- `FOUNDRY_PROFILE=ci` runs with at least 1,000 runs and depth 100 and no failures, or every failure
  is written up.
- Each property is a named invariant function traceable to a spec section.

## Handoff

`docs/handoffs/C9.md`. For every failure: the minimal reproduction, which spec section it violates,
and whether you believe the code or the spec is wrong. Don't fix contract code yourself.
