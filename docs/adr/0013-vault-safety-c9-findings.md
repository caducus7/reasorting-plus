# 0013: vault safety after C9 (findings F1 to F5)

**Status:** Accepted. The project owner said to "implement defaults", and that privileged
owner/platform actions are acceptable and centralisation must not block a fix.

**Evidence:** every fix follows audited prior art, cited in
[review 0002](../reviews/0002-c9-findings-prior-art.md). The C9 report's first-principles fixes were
not used.

**Touches:**
- `IEscrow`: `writeOffVault`, `recoverVault`, `vaultWrittenOff`; events `VaultWrittenOff` and
  `VaultRecovered`; errors `VaultNotSeeded`, `ReserveBelowFloor`, `VaultIsWrittenOff`,
  `VaultNotWrittenOff`, `NotOwnerOrGuardian`.
- `IEscrowFactory`: error `VaultNotSeeded`.
- Escrow storage: `vaultWrittenOff`, appended.
- `LedgerLib.withdrawReserve` gains a parameter.
- Spec 6.1, 6.3 to 6.6 and 10.4, and CLAUDE.md money rule 4.

## 1. Inflation attack: seeded vaults only (F2)

**Rule.** A vault must have at least `MIN_VAULT_SUPPLY` shares outstanding (1e6) in two places:
- when the factory accepts it (`setDefaultVault` and the constructor);
- again at every `deploy`. A seed that was not burned can be withdrawn later, so the approval-time
  check alone is not enough.

The escrow's own shares count toward the supply. Once we hold a position, a donation accrues to us.

**Approval standard for `defaultVault`** (operational; the on-chain check is the backstop). The vault
must be one of:
- **rate-priced**, like Aave's StataTokenV2, which converts with the reserve's normalised income and
  is immune to donations;
- **an OpenZeppelin ERC-4626** with `_decimalsOffset() >= 6`, seeded with shares sent to a burn
  address.

**Mock vault** (testnet and demos, spec 6.6): offset 12, MetaMorpho's value for USDC. Deploy scripts
seed it with shares sent to `0xdEaD`.

**Rejected: a depositor-side value check.** None of Yearn V3, MetaMorpho, Morpho Vault V2 or Euler
Earn has one. OpenZeppelin lists it only as an optional extra layer.

**Residual.** Against a seeded offset-12 vault, a donation can still cost the escrow about two shares
of rounding per deploy. That is `2 + 2·donation/1e12` atomic units, while the attacker's donation is
captured by the seed. The loss is fuzzed in `testFuzz_F2_donationIntoSeededVaultCostsTheEscrowNothing`.

## 2. Pause is a pure flag (F1)

**Rule.** `pauseDeposits` and `unpauseDeposits` do not run `accrue()`, make no external call, and
leave the books untouched.

**Money rule 4 now reads:** `accrue()` is the first call in every function that moves funds or changes
an accounting parameter. Pure flags are exempt.

**Precedent.**
- Aave's `setReservePause` does not sync indexes; `setReserveFactor` and
  `setReserveInterestRateData` do.
- Yearn's `shutdown_vault` does not process reports.

**Why it matters here.** If pausing accrued, a broken vault (§3) would stop the guardian from pausing
deposits, which is exactly when pausing matters.

C9's handler now asserts that pause and unpause leave `lastAssets` and `shortfallSince` unchanged.

## 3. Broken vault: privileged write-off (F3)

**What stays the same.** Accounting keeps reading the vault live (spec 6.1, the Morpho school). No
valuation read is wrapped in try/catch; no audited vault does that.

**The escape** follows Yearn V3 `force_revoke_strategy` and Morpho Vault V2 `removeAdapter`.

`writeOffVault()`:
- callable by the **owner or the guardian**, with no delay (privileged, per the project owner);
- sets `vaultWrittenOff`, after which accounting and payouts ignore the vault;
- then accrues.

**The rest is the existing loss machinery:**
- The position shows as an observed shortfall.
- Guests are paid first from idle; payouts may be partial, and credits stay (money rule 2).
- Owner and fee claims are gated.
- After `LOSS_CONFIRMATION_WINDOW` anyone can recognise the loss. It is absorbed by the reserve,
  then the owner, then `lossDebt`.
- `deploy` reverts with `VaultIsWrittenOff`. *(Amended by ADR 0015 §2: `redeem` stays allowed, and
  `claim` still pulls what the written-off vault can pay, so a write-off never withholds guest
  refunds.)*

**Exception to rule 4.** `writeOffVault` and `recoverVault` set their flag before `accrue()`, because
`accrue()` cannot read a broken vault.

`recoverVault()` (owner or guardian) clears the flag and accrues. It reverts while the vault is still
broken. The recovered value is a gain: it repays `lossDebt` first, then is distributed as yield.
This matches Yearn, where a re-added strategy's loss "will be credited as profit".

**Known consequence.** Value recovered after recognition does not return to the reserve or owner
bucket that absorbed it. It flows as yield, and the owner receives its split.

**Abuse bound.** Writing off a healthy vault harms only the owner first; guests are senior. It is
reversible with `recoverVault`, and both actions are events.

## 4. INV-1 (F4)

Spec 10.4's INV-1 gets a band equal to the contract's own dust threshold:

```
page if  (totalOpenPrincipal + totalDisputed + totalClaimable) - (idle + vaultAssets + lossDebt) >= MIN_LOSS_ATOMIC
```

- **Why the band:** ERC-4626 rounding is a legitimate, tiny loss. MetaMorpho books it into
  `lostAssets`, and Vault V2 says rounding losses are "realizable".
- **Normally unused:** with the §5 reserve floor, the as-written INV-1 holds after honest deploys
  (fuzzed).
- **For C6's monitor:** a shortfall of at least `MIN_LOSS_ATOMIC` that is observed but not yet
  recognised is an incident, and pages.

## 5. Reserve floor (F5)

**Rule.** `deploy` requires `reserve >= RESERVE_FLOOR` (1 USDC, owner-funded).

A reserve withdrawal cannot leave less than the floor while a vault is configured and anyone else is
owed: open principal, disputed, pending or claimable. Leftover vault dust shares do not keep the
floor in force; it serves only other claimants.

**Why.** Dust below `MIN_LOSS_ATOMIC` is not gated (ADR 0009). With the floor it lands on the
owner's reserve, which is always last out, instead of on the last claimant.

**Precedent.**
- MetaMorpho: cover lost assets by supplying "on behalf of address(1)".
- Vault V2: the vault "should be seeded with a sufficient amount of assets".

The owner takes remainders (money rule 1), and the platform is still not a backstop.

**Rejected: Yearn's pro-rata loss assessment.** It conflicts with guests-first (ADR 0009).

## Tests

- `test/unit/VaultSafety.t.sol`: 14 tests, 3 of them fuzzed.
- C9's suite is updated to the amended spec. Pause is now a pure flag. Deploy and reserve
  predictions include the seed and the floor. F2, F3 and F4 now assert the fixed behaviour. The
  harness seeds the vault before the factory accepts it, and funds the reserve floor as the operator
  would.
- Existing unit tests changed only where the floor or rounding moved a figure. Each change is listed
  in the C9-fixes handoff.
