# 0016: Aave integration (D5): Aave's StataTokenV2, no adapter of ours

**Status:** Accepted with C4. The project owner said to "go defaults" and to prefer audited, standard
contracts over custom code.

**Evaluated on a pinned Base mainnet fork** (block 50,715,726, 2026-09-27). The two options were:

- **(a)** Aave's own ERC-4626 wrapper, StataTokenV2 (`AaveV3Base.USDC_STATA_TOKEN`).
- **(b)** A thin OpenZeppelin ERC-4626 over the raw Pool and aUSDC. This was written as a spike only,
  in `contracts/test/fork/spike/ThinAaveAdapter.sol`, and is never deployed.

Addresses come from `bgd-labs/aave-address-book` at commit `f9858202`, file
`src/AaveV3Base.sol`. They are checked on-chain in
`AaveSpike.t.sol::test_addressesMatchTheAddressBookOnChain`:

| Name | Address |
|---|---|
| Pool | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` |
| aUSDC | `0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB` |
| StataTokenV2 USDC | `0xC768c589647798a6EE01A91FdE98EF2ed046DBD6` |

## Evidence (brief criteria)

All figures come from `contracts/test/fork/AaveSpike.t.sol`, and each is asserted there.

| Criterion | (a) StataTokenV2 | (b) Thin adapter |
|---|---|---|
| Contract code we own and must audit | **0 bytes** | 5,700 bytes |
| Round-trip rounding (1M USDC, deposit then redeem in the same block) | 1 atomic unit | 1 atomic unit |
| Fees (30 days on 1M, compared with holding aUSDC directly) | 2,762,441,328 vs 2,762,441,329: **no fee layer** | none |
| Full utilisation (market left with 500k) | `maxWithdraw` 499,999,999,999, capped at market liquidity; withdrawing it succeeds | same |
| Donation / inflation | **Price unchanged** by a 5,000 aUSDC donation (priced from the reserve index) | Price moves; needs a seed and a decimals offset (ADR 0013 §1) |
| Extra contract risk | Aave-audited, upgradeable by Aave governance, pausable by Aave's emergency admin (see the finding below) | Our unaudited code, plus a reward-accounting gap |

## Decision: (a) StataTokenV2

We set it as the factory's default vault. There is no adapter code of ours (spec 6.6, ADR 0008). The
brief's `AaveV3Adapter` functions map onto ERC-4626 as follows:

| Brief | ERC-4626 on the stata token |
|---|---|
| `deposit` | `deposit` |
| `withdraw`, returning the amount | `withdraw`. The escrow measures its balance delta |
| `totalAssets` | `previewRedeem(balanceOf(escrow))`, which reads the live index, not a cached balance |
| `maxWithdrawable` | `maxWithdraw(escrow)`, capped at market liquidity |

**Market liquidity for the rebalancer** (spec 6.6: "a view, off the interface"): this is Aave's own
view, `Pool.getVirtualUnderlyingBalance(USDC)`. It is the same figure the stata token caps
`maxWithdraw` at, and `AaveFork._available()` uses it. C8 reads it off-chain. We ship no contract of
ours for it.

## Finding: the wrapper's pause is an EIP-4626 deviation

Aave's emergency admin can pause the stata token. While it is paused:

- `maxWithdraw` still reports the full position;
- `withdraw` reverts.

EIP-4626 says `maxWithdraw` MUST return 0 when withdrawals are disabled, "even temporarily". The cause
is that `maxRedeem` checks only the reserve's pause flags, while the wrapper's own pause sits in
`_update` (`whenNotPaused`).

This is pinned by `test_pausedWrapperStillReportsMaxWithdraw_EIP4626Deviation`, so an upstream fix
will be noticed.

**Consequence and fix.** A claim that trusted `maxWithdraw` would revert, so a pause at Aave would
block guests from their idle funds too. `LedgerLib.claim` now pulls **best effort**:

1. `try maxWithdraw`, then `try withdraw`.
2. Measure the balance delta and emit `Redeemed(delta)`.
3. Pay `min(requested, idle)`.

The precedent is MetaMorpho, which wraps each market withdraw in try/catch and skips a market that
reverts rather than failing the user's exit (`MetaMorphoV1_1.sol:839-840`, `morpho-org/metamorpho-v1.1@3b17547`,
review 0002). It matches spec 4.5: only the transfer may be partial.
It also covers the written-off vault case of ADR 0015. `test_wrapperPauseDoesNotBlockGuestClaims`
shows a claim paying idle funds while the wrapper is paused.

The rebalancer's `redeem` still reverts while the wrapper is paused. That is correct: there is
nothing to move, and C8 retries.

## Incentives (out of scope, noted per the brief)

The stata token's `INCENTIVES_CONTROLLER()` is `0xf9cc4F0D883F1a1eb2c253bdb46c254Ca51E1F44`. One
reward is registered on aUSDC (the reward token is aUSDC itself). Its `distributionEnd` is
1,725,375,600 (2024-09-03), so **no emissions are active at the pinned block**. If Aave restarts
incentives, the stata token accrues them to the escrow as holder, and claiming them needs a
`claimRewards` call the escrow does not have. That would be a new function, which needs its own ADR.
It is not built.

## Consequences

- Fork tests pass against the pinned block: `AaveSpike` (7), `AaveStataEscrow` (4), and
  `AaveConformance` (4, the shared suite that also runs on no vault and on `MockYieldVault`).
- The testnet `MockYieldVault` (`src/testnet/`) stays separate from Aave (CLAUDE.md §5). It is
  deployed only by `script/DeployTestnetVault.s.sol`, which refuses any chain but Base Sepolia.
- Aave governance can upgrade the stata proxy. The factory admin's `writeOffVault` and
  `setDefaultVault` (ADR 0013), and draining through the rebalancer, are the response. This trust is
  already accepted for the aToken itself.
