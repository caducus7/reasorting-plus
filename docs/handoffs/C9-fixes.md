# C9 fixes handoff (findings F1 to F5)

## Done

Each fix follows audited prior art: [review 0002](../reviews/0002-c9-findings-prior-art.md), decided
in [ADR 0013](../adr/0013-vault-safety-c9-findings.md). The project owner said to implement the
defaults, and that privileged owner/platform actions are acceptable.

| Finding | Fix | Precedent |
|---|---|---|
| F2: inflation attack via an empty vault | Factory and `deploy` require `vault.totalSupply() >= MIN_VAULT_SUPPLY` (1e6). Mock vault: decimals offset 12, seeded to `0xdEaD`. Approval standard: rate-priced (StataTokenV2) or OZ ERC-4626 with offset ≥ 6 and a burned seed. | OZ ERC4626 CAUTION; Morpho Vault V2 adapters; MetaMorpho offset; Euler allowlist |
| F3: a broken vault blocks everything | `writeOffVault()` / `recoverVault()`, owner or guardian. Accounting ignores the vault. The existing loss path pays guests first, then recognises the loss: reserve, then owner, then debt. Recovery books a gain that repays debt first. | Yearn V3 `force_revoke_strategy`; Morpho Vault V2 `removeAdapter` |
| F1: pause skips `accrue()` | Kept as a pure flag. Rule 4 is amended in the spec and CLAUDE.md. | Aave `setReservePause` vs `setReserveFactor`; Yearn `shutdown_vault` |
| F4: INV-1 has no tolerance band | INV-1 includes `lossDebt` and pages at a gap of at least `MIN_LOSS_ATOMIC`. With the floor, it holds as written after honest deploys. | MetaMorpho `lostAssets`; Vault V2 "rounding losses are realizable" |
| F5: dust falls on the last claimant | `deploy` needs `reserve >= RESERVE_FLOOR` (1 USDC). A reserve withdrawal cannot go below the floor while others are owed. | MetaMorpho address(1) top-up; Vault V2 seeding |

### Operating procedures (for the ops runbook when it is written)

- **Before enabling deployment on an escrow:**
  - the owner calls `fundReserve(1 USDC)` or more;
  - the vault is seeded with shares burned to `0xdEaD` before `setDefaultVault`.
- **The vault's views revert** (C6 alert: `accrue` calls failing):
  1. The owner or guardian calls `writeOffVault()`.
  2. Guests keep settling and claiming, paid from idle.
  3. After 6 hours anyone calls `recogniseLoss()`.
  4. When the vault is healthy again, the owner or guardian calls `recoverVault()`.
- **A write-off of a healthy vault:** undo it with `recoverVault()`. Only the owner is exposed in the
  meantime: owner claims are gated, and the owner absorbs first.

## Not done

- **The testnet mock-vault deploy script** belongs to C4 (not started). It must use offset 12 and seed
  the vault to `0xdEaD` before `setDefaultVault`, or the factory rejects it.
- **The C6 monitor for INV-1** must use the amended form (spec 10.4). A shortfall of at least 1 USDC
  that is observed but not yet recognised should page.
- **The ops runbook** (`ops/`) does not exist yet. The procedures above are for it.

## Tests

```
cd contracts
forge test                                   230 passed, 0 failed, 1 skipped (fork, needs BASE_RPC_URL)
FOUNDRY_PROFILE=ci forge test                230 passed, 0 failed, 1 skipped (361 s)
                                             all invariants 1,000 runs x 100,000+ calls, 0 reverts
BASE_RPC_URL=https://mainnet.base.org forge test --match-path 'test/fork/*'
                                             7 passed (pinned block 50,715,726)
forge coverage --report summary --no-match-path 'test/fork/*'
  Escrow.sol         100% lines, statements, branches (62/62), functions
  EscrowFactory.sol  100% (branches 11/11)
  LedgerLib.sol      100% (branches 41/41); all other src libraries 100%
slither src --exclude-dependencies           33 results; none in the new or changed code
forge build --sizes                          Escrow 21,687 B (2,889 B under EIP-170)

cd services && pnpm -r test                  abi up to date; shared 32; api-stub 49; quote-service 66
cd services/apps/quote-service && pnpm test:anvil   4 passed (differential, straddle, signature, E2E)
```

New: `test/unit/VaultSafety.t.sol`, 14 tests. Three are fuzzed: donation cost, dust on the reserve,
INV-1 as written.

### Existing tests changed

Every change follows the amended spec (ADR 0013). None weakens a property.

- **`test/utils/Mocks.sol`:** `MockVault` gets offset 12 and a `setBroken` switch. `ZeroShareVault`
  gets a `seed` helper.
- **`test/utils/YieldTestBase.sol`:**
  - seeds the vault with 1 atomic unit to `0xdEaD`;
  - `_deploy` funds the 1 USDC floor first, which is the operator step.
- **`test/unit/Yield.t.sol`:**
  - `_intoDebt`: the floor absorbs the first 1 USDC, so debt is 999, not 1,000.
  - `test_recogniseLoss_absorptionOrder`: the loss is 2–3 atomic units less, because the seed and
    virtual shares hold part of it. Checked with `VAULT_ROUNDING` on the loss; reserve and owner
    stay exact.
  - `test_whileDebt_guestClaimsFromIdleThenVault`: the guest gets 4,641, not 4,640. The floor's USDC
    now backs guests.
  - `test_deploy_eachCapHasItsOwnError`: adds the `ReserveBelowFloor` step. Boundaries shift by the
    1 USDC now idle.
  - `test_reserve_illiquid`: withdraws 999 (it keeps the floor), and still proves
    `ReserveInsufficient` under illiquidity.
  - `test_deploy_revertsIfVaultMintsNoShares`: seeds and funds first. The balance to expect
    includes the reserve.
- **`test/unit/Claim.t.sol`, `test/unit/Factory.t.sol`:** seed vaults. Factory now also asserts
  `VaultNotSeeded` for an unseeded vault.
- **`test/invariant/YieldHandler.sol`:** funds the floor before `deploy`, as the operator would.
  Without it, the try/catch would silently skip deploys.
- **C9 suite (`test/invariant/independent/`):**
  - pause and unpause are checked as pure flags (books unchanged);
  - deploy predictions include the seed and the floor;
  - reserve-withdrawal predictions include the floor;
  - the harness seeds before the factory accepts the vault, and funds the floor at setUp and each
    coverage episode;
  - F2, F3 and F4 tests now assert the fixed behaviour;
  - the boundary-loss test expects reserve 101 (100 + floor).
- **`foundry.toml`:** `gas_limit = 2^32`, test-only. The C9 coverage driver (30 escrows × 120
  actions) exceeded the 2^30 default once deploys became reachable again.

### Also fixed (C5 test harness)

`services/apps/quote-service/test/pgtest.ts` teardown raised an uncaught `57P01` in 2 of 6 runs,
while every test passed.

- **Cause** (read in pg-pool 3.14 `_remove`): `pool.end()` resolves before client sockets close.
  `DROP DATABASE … WITH (FORCE)` then kills those backends.
- **Fix:** retry a plain `DROP` while it fails with 55006 (connections still open). `FORCE` is used
  only after about 5 s.
- **Result:** 10 of 10 runs clean.

## Deviations from spec

None. The spec is amended by ADR 0013: sections 6.1, 6.3 to 6.6 and 10.4, and the ADR table.
CLAUDE.md money rule 4 and the "designs that look like bugs" table are updated to match.

## Spec concerns

- **Recovery after recognition flows as yield, not back to the absorber.** Value recovered after
  recognition goes to the open bookings' yield, not back to the reserve and owner bucket that
  absorbed the loss. This is the Yearn precedent and is documented. If the owner prefers restitution
  to the absorbers, that is a later change to `accrue()`'s gain path.
- **Single-party write-off.** `writeOffVault` is single-party (owner or guardian) by the project
  owner's centralisation guidance. A two-party variant is an easy tightening if wanted later.

## Interfaces changed

[ADR 0013](../adr/0013-vault-safety-c9-findings.md):
- `IEscrow`: `writeOffVault`, `recoverVault`, `vaultWrittenOff`; events `VaultWrittenOff` and
  `VaultRecovered`; five errors.
- `IEscrowFactory`: `VaultNotSeeded`.
- ABIs are regenerated (`contracts/abi/*.json`, `@chain/abi`). The C5 service is unaffected: it
  calls none of the changed functions, and its tests pass.

## Blocked

Nothing.
