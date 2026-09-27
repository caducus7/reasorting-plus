# Review 0002: C9 findings against audited prior art

**Purpose:** the project owner asked for each C9 finding to be checked against how verified,
audited vaults prevent the same problem, before choosing a fix. The first-principles fixes in the
C9 report were set aside. Nothing here is implemented yet.

**Sources:** shallow clones read on 2026-09-27. Citations are `repo@commit path:line`.

| Repo | Commit |
|---|---|
| yearn/yearn-vaults-v3 | 89ab996 |
| morpho-org/vault-v2 | 9ee4dbd |
| morpho-org/metamorpho-v1.1 | 3b17547 |
| euler-xyz/euler-earn | ea3dacc |
| aave-dao/aave-v3-origin | 8305565 |
| OpenZeppelin Contracts | 5.6.1 (our `lib/`) |

## F2: a donation to an empty vault makes `deploy` lose value

### What the audited code does

- **OpenZeppelin `ERC4626.sol`** (CAUTION block) names three layers:
  1. The deployer makes "an initial deposit of a non-trivial amount".
  2. Virtual shares via `_decimalsOffset()`. With offset 0 the attack is only unprofitable: the
     victim still loses. A larger offset makes it "orders of magnitude more expensive".
  3. Users "verifying the amount received is as expected", through a wrapper such as
     ERC4626Router (min-out slippage checks).
- **Morpho Vault V2** puts the protection on the downstream vault, as a precondition.
  `MorphoVaultV1Adapter.sol:15-16` says: "must be used with Morpho Vaults V1 that are protected
  against inflation attacks with an initial deposit". `VaultV2.sol:40-42` says the same for itself.
  Adapters can be restricted by an `adapterRegistry` (`VaultV2.sol:95-101`).
- **MetaMorpho** uses `DECIMALS_OFFSET = 18 - decimals` (12 for USDC) (`MetaMorphoV1_1.sol:147`).
- **Euler Earn** deposits into strategies with no value check (`EulerEarn.sol:431`). Strategies
  must pass a factory allowlist (`isStrategyAllowed`, `EulerEarn.sol:301,508`). Its README lists
  "zero shares protection on deposits", which is the guard we already have.
- **Yearn V3** books strategy debt at the measured cost (`VaultV3.vy:1124-1134`). It does not
  value-check shares, and strategies are role-approved.
- **Aave StataTokenV2**, our production target (D5), converts with
  `assets × RAY / getReserveNormalizedIncome` (`ERC4626StataTokenUpgradeable.sol:292-309`). The
  price does not depend on `totalAssets / totalSupply`, so a donation cannot move it. It is immune
  to F2.

### Consensus

- The defence lives on the vault side (seed plus virtual offset), and an allowlist admits only
  such vaults.
- None of the four aggregators checks share value on the depositor side on-chain. OpenZeppelin
  endorses a depositor-side check only as an extra layer, and only as an ERC4626Router-style
  min-out supplied by the caller.

### What this means for us

- `EscrowFactory._setDefaultVault` is our allowlist, but it checks only `asset() == usdc`.
- Our mock vault (`test/utils/Mocks.sol:47`) has offset 0 and no seed.
- The stata wrapper is immune. F2 affects only balance-priced vaults: the mock, and any future
  non-Aave vault.

## F3: a vault whose view functions revert blocks every accrue-first function

### What the audited code does

Two schools, and neither wraps valuation reads in try/catch.

- **Stored accounting (Yearn V3).**
  - `_total_assets = total_idle + total_debt`, both stored (`VaultV3.vy:452-456`). User paths
    never read a strategy's views.
  - Gains and losses enter only through a keeper's `process_report`.
  - A broken strategy is removed with `force_revoke_strategy` (`VaultV3.vy:1777-1788`). That
    "write[s] off any debt left in it as a loss" (`:1780`, logic at `:970-977`). If it was removed in error, "it
    can be re-added and the loss will be credited as profit" (`:1784`).
- **Live reads plus a governance escape (Morpho).**
  - Vault V2 sums `adapter.realAssets()` live (`VaultV2.sol:670-678`).
  - Morpho states the failure outright: "If expectedSupplyAssets reverts … the vault will not be
    able to accrueInterest" (`MorphoVaultV1Adapter.sol:23-24`).
  - The escape is a timelocked `removeAdapter` (`VaultV2.sol:442`). Once the adapter is removed,
    its assets are no longer counted, which writes them off.
- **MetaMorpho's try/catch** (`MetaMorphoV1_1.sol:815-816, 839-840`) is used only to skip a
  failing market while moving funds. It never wraps valuation.

### What this means for us

- Our design is the Morpho school: live `previewRedeem` in `accrue()`, as spec 6.1 requires. We
  lack its governance escape.
- A fallback to idle funds, wrapping `accrue()` in try/catch, has no audited precedent.

## F1: `pauseDeposits` / `unpauseDeposits` skip `accrue()`

### What the audited code does

- **Aave `PoolConfigurator`:**
  - `setReservePause` (`:260`) does not sync indexes.
  - `setReserveFactor` (`:273`, sync at `:279`) and `setReserveInterestRateData` (`:457`, sync at
    `:461`) call `syncIndexesState` first.
  - The rule Aave follows: accrue before anything that changes how accrued value is computed or
    split. Pure flags don't accrue.
- **Yearn `shutdown_vault`** (`VaultV3.vy:1834-1855`) does not process reports.

### What this means for us

- Every other state-changing escrow function accrues. Only the two pause flags do not.
- Adding `accrue()` there would make pausing depend on the vault. With a broken vault (F3), the
  guardian could not pause deposits, which is exactly when a pause matters.

## F4: INV-1 as written breaks by 1 atomic unit after an honest deploy

### What the audited code does

- **MetaMorpho books the nominal amount, as we do** (`lastTotalAssets + assets`). It documents that
  this "may be a little above `totalAssets()`. This can lead to a small accrual of `lostAssets`"
  (`MetaMorphoV1_1.sol:692-695, 707-710`). Its accounting identity carries that loss term
  (`:934-935`).
- **Vault V2:** "Losses that correspond to rounding errors are realizable"
  (`MorphoVaultV1Adapter.sol:21`). Separately, `VaultV2.sol:43-46` advises seeding the vault so
  that dust is negligible.

### What this means for us

- The code matches audited practice. The spec's invariant needs the loss term, which is the
  loss-adjusted form in ADR 0009.

## F5: up to 1 USDC of dust can fall on the last claimant

### What the audited code does

- **Yearn** has no threshold. Withdrawers pay their pro-rata share of unrealised losses
  (`_assess_share_of_unrealised_losses`, defined at `VaultV3.vy:705`, applied on withdrawal at `:631`).
- **MetaMorpho:** "In order to cover those lost assets, it is advised to supply on behalf of
  address(1)" (`IMetaMorphoV1_1.sol:82-83`). The curator funds a first-loss top-up.
- **Vault V2** says the vault "should be seeded with a sufficient amount of assets" against
  rounding dust (`VaultV2.sol:43-46`).

### What this means for us

- Pro-rata loss sharing (Yearn) conflicts with "guests are paid first" (ADR 0009). It is ruled out.
- The Morpho practice maps onto our owner-funded reserve (spec 6.5). A floor of at least
  `MIN_LOSS_ATOMIC` while funds are deployed would absorb any sub-threshold dust. The owner
  already takes remainders, so the platform is still not a backstop.

## Recommendations

These are proposals only and need the owner's decision.

| # | Recommendation | Precedent | Needs |
|---|---|---|---|
| F2a | Vault approval standard: rate-priced (like stata), or an OpenZeppelin ERC-4626 with `_decimalsOffset() >= 6` and a dead-share seed. On-chain, `_setDefaultVault` also requires a minimum seed (`totalSupply` above a floor), as defence in depth. | OpenZeppelin, Morpho, Euler | Factory change + ADR |
| F2b | Mock vault: offset 12 (MetaMorpho's value for USDC) and a dead-share seed in the deploy scripts. | MetaMorpho, OpenZeppelin | Test/mock change |
| F2c | Optional third layer: `deploy(assets, minSharesOut)` from the rebalancer, in the ERC4626Router style. | OpenZeppelin CAUTION, ERC4626Router | `IEscrow` change + ADR |
| F3 | Keep the live reads. Add a Yearn/Morpho-style escape, `writeOffVault()`: two-party (guardian + owner), callable only when the vault's views actually revert (checked by try/catch inside this permissioned function). It books the last known position as a loss through the existing absorption order, then stops reading the vault. `recoverVault()` later books anything recovered as a gain, repaying `lossDebt` first. | `force_revoke_strategy`, `removeAdapter` | `IEscrow` change + ADR; a documented exception to rule 4 |
| F1 | Keep the code. Amend rule 4 by ADR: accrue first in every function that moves funds or changes an accounting parameter. Pure flags are exempt and make no external calls. Then update C9's F1 invariant to the amended rule, and report that change. | Aave pause vs reserve factor, Yearn shutdown | Spec amendment (ADR) |
| F4 | State INV-1 in the loss-adjusted form (ADR 0009), and tell C6 to monitor that form. | MetaMorpho `lostAssets`, Vault V2 | Spec amendment |
| F5 | Owner-funded reserve floor: `deploy` requires `reserve >= MIN_LOSS_ATOMIC`, and a reserve withdrawal cannot go below it while shares are held. | MetaMorpho address(1) top-up, Vault V2 seeding | Contract change + ADR |
