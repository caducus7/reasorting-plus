# 0006: open items after review 0005, researched and closed on defaults

**Scope:** the four items review 0005 left open, plus a check of the prior art review 0005 cited. The
owner's instruction: "research every finding and go with the default correct solution".

## Results

| # | Item | Default adopted | Evidence and prior art | Tests |
|---|---|---|---|---|
| G1 | C7: a feed that suddenly drops many blocks reopens dates | **Hold, alert, operator approval.** Additions and changes still import; unapproved removals of ≥ 2 future blocks and > 50% of them, or an emptied feed, are held until `pnpm confirm-removals <feedId>`. The hold clears itself if the feed recovers. ADR 0018 §4a | Microsoft Entra Connect, "prevent accidental deletes": a delete threshold, on by default (500), stops the export until an admin approves. rsync / rclone `--max-delete`. Adapted: here a kept block is the safe side, so additions still apply | `ical-sync/test/review/mass-removal.test.ts` (7). Mutation check: the tests fail with the guard off (5 of 7), without the empty-feed rule (1) and with approvals ignored (2) |
| G2 | C8: the 5x liquidity exit can fire during a depeg | **Keep it (no behaviour change).** The previous "spec concern" was wrong: the position is a USDC claim against USDC liabilities, so a redeem realises no depeg loss. What a depeg threatens is pool liquidity and bad debt, which the exit exists for. ADR 0019 §2a | Aave, March 2023: the guardian froze stablecoin reserves and set their LTV to zero; withdrawals went on (Gauntlet, "Aave Resilient Through USDC Volatility"). A stata/aToken redeem pays at the liquidity index, not at the USD price | `rebalancer/test/policy.test.ts`: "depeg and a liquidity crunch together", "the exit does not wait on the oracle" |
| G3 | C8: USDC/USD deviation threshold on Base unknown | **Still unconfirmed; kept as a pre-mainnet check.** `docs.chain.link`, `data.chain.link` and the reference data directory are blocked by the egress proxy. One web-search summary said 0.3%, but it echoed the query and a neutral query did not reproduce it, so it is not used | On chain, 149 rounds (2026-04-15 to 2026-09-29): heartbeat 24 h (median 86,418 s), no move above 0.026% between rounds, so no deviation trigger was observable. `docs/spikes/c8-price/usdc-usd-base-rounds-phase2-3.csv`. The gate only stops deploys, so a late signal is not a loss of funds (ADR 0019 §1) | none (no code change) |
| G4 | C6: Ponder's `/status`, `/metrics`, `/health` and `/ready` have no auth | **Bind to loopback by default.** `pnpm start` passes `--hostname ${PONDER_HOST:-127.0.0.1}`, and the nightly replay and the test harness bind to 127.0.0.1. Production sets `PONDER_HOST` to a private interface | Secure by default (OWASP ASVS). Ponder 0.17.12's `server/index.js` registers these routes without auth and passes `hostname` straight to `serve()` (read in `node_modules`) | indexer Anvil suite (10) passes with the loopback bind |

## Re-check of review 0005's prior art

| # | Claim | Checked against | Result |
|---|---|---|---|
| R1 | viem keys nonces on (address, chainId) | `viem@2.56.9/utils/nonceManager.ts`: ``getKey = ({ address, chainId }) => `${address}.${chainId}` `` | Holds |
| R5 | OWASP says not to log session identifiers or URLs carrying tokens | OWASP Logging Cheat Sheet, "Data to exclude" | Holds |
| R6 | Ponder leaves auth to the app | Ponder source, as in G4 | Holds; G4 closes the deployment gap |
| R2–R4, R7, R8 | SRE no-silent-failure, level-triggered reconciliation, outbox retention | General practice; no single source to cite | No change |

## Regression

- `pnpm -r test`:

  | Package | Tests |
  |---|---|
  | shared | 32 |
  | signer | 3 |
  | api-stub | 49 |
  | indexer | 70 |
  | quote-service | 78 |
  | ical-sync | 32 (+7) |
  | rebalancer | 39 (+2) |

- Anvil: indexer 10, ical-sync 3.
- `pnpm -r build` succeeds.
