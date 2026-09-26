# 0007: C1 defaults for review 0001 findings 3, 4, 5, 8, 9 and 13

**Status:** Applied by C1 at the project owner's instruction ("treat blockers with your default
suggestion and report afterwards"). Each item changes or fills in spec text; the project owner
should confirm.
**Touches:** `IEscrow`, `IEscrowFactory`, events (shared interfaces).

## 1. Owner credits in an address-independent bucket (finding 3)

Settlement credits `guestClaimable[guest]`, `feeClaimable[feeRecipient]` and a single
`ownerClaimable`. The owner bucket is paid to whoever is `payoutAddress` **at claim time**.

- Rotating the payout address can no longer strand credits, or put them beyond the `lossDebt`
  claim gate or step-2 loss absorption (C2 debits `ownerClaimable`).
- While `lossDebt > 0`, `claim()` pays only the caller's guest bucket. A caller holding only owner
  or fee credits reverts `LossDebtOutstanding` (spec 4.5). An owner who is also a guest still gets
  their guest refund. The spec's wording would have reverted that too.
- `claim()` with nothing claimable returns 0 instead of reverting, so the `[cancelByGuest, claim]`
  bundle (ADR 0003) survives a 0% refund.
- Spec 7's "`resolve` reads ... payout address from the booking" becomes "credits the owner
  bucket". C3 must follow this.

## 2. Onboarding: admin approves, owner creates (finding 4)

`factoryAdmin.approveOwner(owner, maxFeeBps, feeBps, maxOpenPrincipalAtomic)`, then
`owner.createEscrow(payoutAddress, quoteSigner)`. The owner's own transaction is its on-chain
consent to `maxFeeBps`. Nobody can create an escrow with terms the admin did not offer, and the
approval is consumed. The brief's `createEscrow(owner, maxFeeBps, initialFeeBps, ...)` becomes this
two-step flow. The factory is `Ownable2Step`, and renouncing ownership is disabled.

## 3. Freeze (findings 5 and 9)

- `freezeBooking` accepts `ESCROWED` (including time-derived DELIVERED) **and `DISPUTED`**, and
  records `frozenFrom`. `unfreezeBooking` restores `frozenFrom`.
- Each booking has a **cumulative freeze budget of 30 days** (`MAX_FREEZE_DURATION`). The guardian
  may unfreeze at any time. Once the budget is used, **anyone** may unfreeze and the booking cannot
  be frozen again. A compromised guardian can delay a booking by at most 30 days in total, never
  strand it.
- For C3: time spent frozen does not extend `GRACE` (spec 3.5). C3 decides the same for
  `DISPUTE_WINDOW`.
- The guardian is read live from the factory (`factory.guardian()`), so replacing a compromised
  guardian Safe takes one admin call for every escrow.

## 4. Escrowed-value cap (finding 8, spec 12.3)

`maxOpenPrincipalAtomic` per escrow. It is set initially from the admin's approval, then by the
owner (`setMaxOpenPrincipal`), because the owner is the party who must be able to cover a loss. A
deposit reverts `EscrowCapExceeded` if `totalOpenPrincipal + price` would exceed it. The check sits
between guards 11 and 12.

## 5. Timelocks (finding 13)

`proposeFeeBps` and `proposeArbitrator` promote an already-effective pending value before
overwriting, and the factory does the same for `proposeFeeRecipient`. Deposit snapshots the
**effective** arbitrator.

## 6. Standard components over custom code

- Deposit pausing is OpenZeppelin `Pausable`, so the events are `Paused(account)` /
  `Unpaused(account)` instead of spec 4.7's `DepositsPaused` / `DepositsUnpaused`. Guard 5's paused
  error is OpenZeppelin's `EnforcedPause`.
- Escrow ownership is `Ownable2StepUpgradeable`, which adds two-step owner rotation (not in spec
  3.3). Renouncing is disabled because it would strand `cancelByProperty` and C2's `topUpLoss`.
- Reentrancy protection is `ReentrancyGuardTransient` on every state-changing external function.
  `claim()` follows strict checks-effects-interactions: the vault pull is sized from views, and all
  state is written before the vault withdrawal and the transfer.

## 7. Events

`BookingDeposited` carries every term, including `policyHash`, the cutoffs, the snapshotted
arbitrator and `accAtDeposit`. `BookingSettled` carries the principal settled, the six figures, the
`Outcome` and the fee recipient credited. Added: `MaxDeployBpsSet`, `MaxOpenPrincipalSet`. The full
C2 and C3 event set is declared now, so the ABI is stable for C6.

## 8. The price floor is mandatory (found while writing C1)

`minNightlyAtomic` defaulted to 0, which disables the only on-chain bound on a compromised quote
signer (spec 3.3: "the contract bounds the damage with `priceAtomic >= minNightlyAtomic * nights`").
Now `createEscrow(payoutAddress, quoteSigner, minNightlyAtomic)` requires it to be non-zero, and
`setMinNightlyAtomic(0)` reverts `ZeroMinNightly`.
