# C4: Yield adapters

**Read first:** `CLAUDE.md`; `docs/chain-spec.md` sections 6.3, 6.6, 6.7, 14 (D5);
`docs/handoffs/C1.md`, `C2.md`.
**Depends on:** C2 (the interface and how the escrow calls it).

## Goal

`MockYieldAdapter` for testnet and demos, and `AaveV3Adapter` proven on a Base mainnet fork.
`NullAdapter` already exists from C1.

## In scope

- **MockYieldAdapter:** settable APY (accrues linearly by `block.timestamp`), settable
  `maxWithdrawable`, a `injectLoss(amount)` for demos and tests, `onlyEscrow` on deposit and
  withdraw, and an owner-only admin for the knobs. A deploy script that wires it to a Base Sepolia
  escrow.
- **Decision spike (D5):** on the fork, prototype both (a) the raw Aave V3 Pool with aUSDC and
  (b) an ERC-4626 wrapper over Aave USDC if a maintained one exists on Base. Compare: code size,
  rounding behaviour on withdraw, withdraw behaviour under full utilisation, extra contract risk,
  fees. Write `docs/adr/NNNN-aave-integration.md` with the evidence, then build only the chosen one.
- **AaveV3Adapter:** `deposit`, `withdraw` returning the amount actually withdrawn, `totalAssets`,
  `maxWithdrawable` (bounded by the market's available liquidity), and a view
  `marketAvailableLiquidity()` for the rebalancer.
- Addresses from the official Aave address book package, pinned, with the source in a comment.

## Out of scope

Rebalancer logic (C8). Any other protocol. Reward token claiming (note in the handoff if Aave
incentives exist on the market, but don't implement).

## Write these tests first (fork, pinned block)

1. Round trip: deposit then full withdraw returns principal plus accrued minus at most 2 atomic units
   of rounding, documented.
2. Liquidity crunch: manipulate the fork (for example a large borrow from a funded test account) so
   available liquidity is below our position; `withdraw` returns a partial amount and doesn't revert,
   and the escrow's `claim` pays partially per spec 4.5.
3. `totalAssets` never over-reports relative to what `withdraw` can return at full liquidity.

## Acceptance

- Mock and Aave adapters both pass a shared adapter conformance suite
  (`test/unit/AdapterConformance.t.sol`) parameterised over implementations, including NullAdapter.
- Only the escrow can move funds through an adapter.
- The ADR exists and states the choice with fork evidence.

## Watch for

- Do not merge the mock and the real adapter "to reduce duplication". See `CLAUDE.md` section 5.
- aToken balances rebase; `totalAssets` must read the live balance, not a cached one.
- Never run correctness tests against testnet Aave.

## Handoff

`docs/handoffs/C4.md` with the ADR link and the pinned fork block.
