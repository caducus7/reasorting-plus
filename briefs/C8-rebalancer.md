# C8: Rebalancer

**Read first:** `CLAUDE.md`; `docs/chain-spec.md` sections 6.3, 6.4, 6.7, 8, 10.2, 10.4 (INV-5);
handoffs for C2, C4, C6.
**Depends on:** C4 adapter (and its `marketAvailableLiquidity()` view), C6 projections and head
events.

## Goal

An off-chain service, one loop per escrow, that deploys and redeems within the on-chain caps
according to spec 6.7, and never puts a refund at risk.

## In scope

- `services/apps/rebalancer/`, signing with the escrow's `rebalancer` key via the same signer
  abstraction as C5 (KMS in deployed environments).
- **Required liquid amount**, computed from the `finalized` ledger and calendar projections:
  claimables, disputed and pending amounts, plus principal of every booking with check-in within
  14 days (including in-stay and awaiting settlement), floored at `MIN_BUFFER_BPS` of liabilities.
  Publish it so C6 can evaluate INV-5.
- **Decisions each cycle:**
  - redeem if idle is below the required amount
  - redeem all if market available liquidity falls below 5x our position
  - deploy the excess only if: `lossDebt == 0`, excess >= 500 USDC, only finalised deposits count,
    liquidity after the move >= 20x our position, USDC price within ±1%, and the on-chain caps
    permit it
  - never redeem because of a USDC price move
- **Dry-run mode** that logs decisions without sending transactions. It's the default in every
  environment until the owner switches it off.
- A decision log (inputs, decision, tx hash) stored for audit.
- Price source for the USDC depeg check: document the choice (for example the Chainlink USDC/USD
  feed on Base) in an ADR, including staleness handling. If the price is stale, halt deployment.

## Out of scope

Choosing thresholds beyond the spec defaults. Use the defaults and make them config, then record in
the handoff what 90 days of Aavescan history suggests for the 20x and 5x values.

## Write these tests first

1. A table of scenarios (booking inside 14 days, liquidity crunch, depeg, `lossDebt`, stale price,
   dust excess) with the expected decision for each, run against a fake chain.
2. On Anvil with the MockYieldAdapter: a booking entering the 14-day window is fully redeemed before
   check-in minus 14 days plus one cycle.
3. The rebalancer can never produce a transaction the on-chain caps would reject (it pre-checks) and
   never loops on a revert.

## Acceptance

- Dry run on Base Sepolia for a week with the MockYieldAdapter, decision log reviewed.
- Every decision is explainable from the log alone.

## Watch for

- Failing safe means not deploying. It never means redeeming during a depeg.
- Nonce management and stuck transactions: a replacement strategy that doesn't double-deploy.

## Handoff

`docs/handoffs/C8.md` with the price-feed ADR and the threshold recommendation.
