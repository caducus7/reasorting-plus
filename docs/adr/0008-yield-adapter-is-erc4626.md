# 0008: yield adapter interface is ERC-4626

**Status:** Proposed by C1 at the project owner's instruction to prefer ERC standards and audited
code over custom interfaces. **Replaces `IYieldAdapter` (spec 6.6).** C2, C4 and C8 must confirm
before they build.

## Decision

The escrow holds shares of an ERC-4626 vault whose `asset()` is USDC. The factory rejects any other
asset. `address(0)` means no vault, and replaces `NullAdapter`.

| Spec 6.6 `IYieldAdapter` | ERC-4626 equivalent used by the escrow |
|---|---|
| `deposit(amount)` (onlyEscrow) | `vault.deposit(assets, receiver = escrow)` (C2's `deploy`) |
| `withdraw(amount, to) returns withdrawn` | `min(amount, vault.maxWithdraw(escrow))`, then `vault.withdraw(assets, receiver = escrow, owner = escrow)` |
| `totalAssets()` | `vault.previewRedeem(vault.balanceOf(escrow))` |
| `maxWithdrawable()` | `vault.maxWithdraw(escrow)` |

CLAUDE.md money rule 3's single exception becomes: the escrow always passes itself as both
`receiver` and `owner`. `test_claim_pullsShortfallFromVault_receiverIsEscrow` checks this.

## Why

- **Standard, audited, widely integrated.** OpenZeppelin ships an audited `ERC4626`. Aave publishes
  ERC-4626 wrappers over aTokens ("stata" tokens), which is option (b) of decision D5, so the
  production path can need **no custom adapter code at all**. On Base, `AaveV3Base.USDC_STATA_TOKEN`
  is `0xC768c589647798a6EE01A91FdE98EF2ed046DBD6` (bgd-labs/aave-address-book, commit f985820). C4
  verifies it on the fork before use.
- **Mock and production stay separate** (CLAUDE.md section 5): the demo vault is an OpenZeppelin
  `ERC4626` with a yield and loss injector; production is the chosen Aave wrapper. Both are tested
  against the same conformance suite (C4).
- **Partial withdrawal is preserved.** Spec 4.5 needs "pay what you can". ERC-4626 withdraw reverts
  above `maxWithdraw`, so the escrow bounds every pull by it first. The liquidity-crunch tests cover
  this.

## Risks for C2 and C4

- **Rounding favours the vault** (shares rounded up on withdraw, assets down on redeem). Expect at
  most a few atomic units of apparent loss per round trip. C2's loss-threshold ADR must absorb it,
  or `recogniseLoss` can be griefed.
- **Inflation attack on an empty vault.** This only matters for a fresh vault the escrow is first
  into. OpenZeppelin's virtual-shares offset mitigates it, and an Aave wrapper is not empty. C4 must
  check on the fork.
- **Selection (D5) is still open.** C4 prototypes the raw Aave pool behind a thin ERC-4626 adapter
  and Aave's own ERC-4626 wrapper on a pinned Base fork, and records the evidence.
