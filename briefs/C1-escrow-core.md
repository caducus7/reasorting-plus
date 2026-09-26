# C1: Factory and escrow core

**Read first:** `CLAUDE.md` in full; `docs/chain-spec.md` sections 2, 3, 4, 6.1 (accrue hook
only), 6.4 (the `lossDebt` gates only), 13 and 14.
**Depends on:** nothing. Every other contract package depends on your types, so publish
`IEscrow`, `IEscrowFactory`, the `Quote` struct and the events **first**, in your first commit,
and flag them in an early interim handoff.

## Goal

`EscrowFactory` and `Escrow` with quotes, deposits, cancellation, settlement, claims, economic
configuration and roles, running with a `NullAdapter`. Yield maths (C2) and disputes (C3) plug into
hooks you leave.

## In scope

- `EscrowFactory`: EIP-1167 clones; `createEscrow(owner, maxFeeBps, initialFeeBps, ...)`;
  `factoryAdmin` powers from spec 3.3; fee recipient with timelock; arbitrator and guardian
  defaults; `MAX_FEE_BPS` and delay constants.
- `Escrow`:
  - initialiser (clones cannot use constructors); protect against re-initialisation
  - roles and every owner, guardian and factoryAdmin function in spec 3.3
  - economic config and lazy timelocks exactly as spec 3.4, including `effectiveFeeBps()`
  - EIP-712 domain bound to the escrow address and chain ID; `bookingId = hashStruct(quote)`
  - `deposit` and `depositWithPermit` with all 12 guards in spec 4.2, in order, with custom errors
  - `cancelByGuest`, `cancelByProperty`, `settle`, `freezeBooking`, `unfreezeBooking`,
    `pauseDeposits`, `unpauseDeposits`
  - settlement function implementing spec 4.4 exactly, including the D3 branch with its
    "INTENTIONAL" comment
  - `claim` per spec 4.5, including adapter pull on shortfall and the `lossDebt` restrictions
  - every event in spec 4.7
- `NullAdapter` (it is small, and C1 needs an adapter to be complete).
- Hooks: an internal `_accrue()` that C2 fills in (in C1 it just updates `lastAssets`), and a
  `_crystalliseYield(bookingId)` that returns 0 until C2.
- Deployment script for Base Sepolia.

## Out of scope

Accumulator maths, deploy and redeem, loss recognition, reserve (C2). Disputes (C3). Other adapters
(C4). Anything off-chain.

## Write these tests first

In `test/unit/` and `test/invariant/`, **before** the happy path:

1. For every settlement path, fuzzed: `refund + ownerPrin + fee == principal`,
   `guestY + ownerY == y`, `fee <= retained`.
2. Solvency: after any sequence of deposits, cancels, settles and claims,
   `usdc.balanceOf(escrow) + adapter.totalAssets() >= totalOpenPrincipal + totalClaimable`.
3. Guest never short-changed: no sequence reduces a guest's credited refund below
   `ceilDiv(principal * refundBps, 10_000)` for the time of cancellation.
4. Term immutability: no function call after deposit changes any stored booking term.
5. Fee cannot be waived: a quote with `feeBps != effectiveFeeBps()` always reverts, including
   across a pending fee change becoming effective.

## Acceptance

- All 12 deposit guards have a revert test with the specific custom error.
- The smart-wallet path is tested by a test contract that performs `approve` and `deposit` in one
  transaction as `q.guest`.
- The `depositWithPermit` front-run case is tested: permit is consumed by a third party first, and the deposit
  still succeeds.
- `quoteSigner` as an ERC-1271 contract is tested.
- Timelock tests: fee and fee recipient changes are not effective before `effectiveAt` and are
  effective at it, with no transaction in between.
- Frozen bookings cannot cancel, settle or dispute; unfreeze restores the clock-derived state.
- USDC on fork: `test/fork/UsdcDeposit.t.sol` deposits real Base USDC (pinned block) through both
  entry points. **Confirm the Base USDC `permit` interface on the fork before writing
  `depositWithPermit`.** If it differs from the spec, stop and report.
- Branch coverage on `Escrow` and `EscrowFactory` at or near 100%, gaps explained.
- `slither` run with every finding triaged in the handoff.

## Watch for

- `ceilDiv` for the guest refund, floor for everything else.
- `feeRecipient` is read from the factory **at settlement**. Arbitrator is snapshotted **at
  deposit**. Don't swap them.
- Check the USDC balance delta on deposit; don't assume `transferFrom` moved exactly
  `priceAtomic`.
- Pack storage sensibly, but don't sacrifice clarity for gas at this stage. Note obvious gas wins
  in the handoff instead.

## Stop and ask if

The Base USDC permit interface differs from the spec; any equality can't hold; you need a new role
or parameter.

## Handoff

`docs/handoffs/C1.md`. Include the final ABI locations and a table of every custom error.
