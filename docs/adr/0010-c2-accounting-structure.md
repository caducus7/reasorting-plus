# 0010: C2 accounting structure, pending-yield release and loss threshold

**Status:** Accepted with C2 (the project owner said to go with defaults). Covers the two ADRs the C2
brief asks for (pending-yield release, loss threshold), plus the structural change C2 needed.
**Touches:** `IEscrow` (new functions, events and errors; `YieldAccrued` signature) and Escrow
storage layout.

## 1. Ledger struct and linked libraries (EIP-170)

C2 on top of C1 came to 24,729 bytes, 153 over the 24,576-byte limit. Lowering `optimizer_runs`
recovered only ~460 bytes, and C3 still has to fit. The accounting state therefore moved into one
`Ledger` struct, and its logic into **external libraries** called by DELEGATECALL: the pattern Aave V3
uses for `Pool` (SupplyLogic, BorrowLogic, …).

| Contract | Runtime size | Role |
|---|---|---|
| `Escrow` | 18,815 B (5,761 B headroom) | bookings, roles, config, thin wrappers, getters |
| `LedgerLib` | 7,016 B | accrue, settle credits, claim, deploy, recogniseLoss, reserve withdrawal |
| `QuoteLib` | 1,943 B | EIP-712 hash, guard 11 |
| `BookingLib` | 1,472 B | booking record and `BookingDeposited` |

Properties:
- Libraries are stateless and immutable. Their addresses are linked into the implementation's
  bytecode at deploy (forge deploys them by CREATE2). They run in the escrow's context, so events
  come from the escrow's address and the ABI is unchanged for C6.
- External names are unchanged: getters such as `lossDebt()` and `guestClaimable(address)` are
  explicit views over the struct.
- The audit scope must include the three libraries.
- C3 should follow the same pattern (a `DisputeLib` taking `Ledger storage`).

## 2. Books identity, and where dust lives

A new field, `yieldUnallocated`, holds yield that has entered the accumulator and not yet been
crystallised by a settling booking. Per-booking round-down leaves dust there; it is accounted for,
never paid. With it, this holds exactly after every state-changing call (invariant
`invariant_booksBalance`):

    lastAssets + lossDebt == totalOpenPrincipal + totalDisputed + totalClaimable
                             + totalPendingYield + reserve + yieldUnallocated

## 3. Pending-yield release (brief item): lazy, per account, on claim

While `lossDebt > 0`, settlement credits principal normally and puts yield into
`pendingGuestYield[guest]` and `pendingOwnerYield` (event `YieldDeferred`). When no loss is active,
`claim()` first moves the caller's deferred yield into its claim bucket (event
`PendingYieldReleased`). Release happens only when there is no debt, so there is no scarcity and no
ordering to decide. That is why a permissionless batch `releasePendingYield(ids[])` was not
needed. Views: `pendingYieldOf(account)`, `pendingGuestYield(account)`, `pendingOwnerYield()`.

## 4. Loss threshold (brief item): `MIN_LOSS_ATOMIC = 1 USDC`

A shortfall below 1 USDC is never observed, gated or recognisable. That stops `recogniseLoss` and
the owner-claim gate from being triggered by ERC-4626 rounding. OpenZeppelin's vault keeps a
virtual share and rounds `convertToAssets` down, so an injected gain or loss reaches the escrow to
within a few atomic units (measured in `test/unit/Yield.t.sol`).

Residual risk: a real loss under 1 USDC is never booked. It is absorbed by future yield (no
distribution until assets pass the high-water mark again). While it lasts, owner claims are not
blocked, so guests can be short by at most that amount.

## 5. Absorption step 2b: the owner's deferred yield

Spec 6.4's order is reserve, owner claimable, lossDebt. The owner's **deferred** yield
(`pendingOwnerYield`) is the owner's money too, so it absorbs after the owner bucket and before
`lossDebt`. `LossRecognised.fromOwner` reports both together. This only moves losses away from
guests.

## 6. Smaller decisions

- `topUpLoss(amount)` takes `min(amount, lossDebt)` and reverts `NoLossDebt` when there is none,
  including when accrual just repaid it.
- `fundReserve` is allowed during a loss; the reserve is only spent by the next recognition. To
  clear debt, use `topUpLoss`.
- Reserve withdrawal is two-step: the owner proposes; the guardian confirms **the exact (amount,
  reason)**, or it reverts `ReserveProposalMismatch`. Proposing 0 cancels. It pays the current
  `payoutAddress`, pulls from the vault if needed, and reverts `ReserveInsufficient` if the reserve
  or liquidity is short.
- `deploy` reverts `VaultMintedNoShares` if the vault returns 0 shares. At a high share price, a
  small ERC-4626 deposit can round to 0 shares and the assets would be lost.
- `redeem` is allowed during a loss (spec 6.4). The rebalancer may always move funds back to idle.
- Deploy caps use spec 6.3's liabilities (open principal, disputed, pending yield, claimable). Each
  violated cap has its own error: `LossDebtOutstanding`, `ShortfallPending`, `BufferBreached`,
  `DeployCapExceeded`. Plus `NoVault`, `ZeroAmount`, `NotRebalancer`.

## Interface changes

- **New functions:** `deploy`, `redeem`, `observeShortfall`, `recogniseLoss`, `topUpLoss`,
  `fundReserve`, `proposeReserveWithdrawal`, `confirmReserveWithdrawal`; views `shortfall`,
  `pendingYieldOf`, `yieldUnallocated`, `shortfallSince`, `pendingGuestYield`,
  `pendingOwnerYield`, `pendingReserveWithdrawal() returns (amount, reasonCode)`.
- **Events:** `YieldAccrued(gain, toReserve, accYieldPerUnit)` (adds `toReserve`, so C6 needs no
  calls); new `ShortfallObserved`, `ShortfallCleared`, `YieldDeferred`, `PendingYieldReleased`,
  `ReserveWithdrawalProposed`. `Redeemed` is also emitted when `claim` or a reserve withdrawal
  pulls from the vault.
- **Errors:** `NotRebalancer`, `NoVault`, `ShortfallPending`, `BufferBreached`, `DeployCapExceeded`,
  `NoLossToRecognise`, `LossWindowOpen`, `NoLossDebt`, `ReserveInsufficient`,
  `ReserveProposalMismatch`, `ZeroAmount`, `VaultMintedNoShares`.
