# Rehearsal handoff: Base Sepolia fork (2026-10-14)

Owner's request: "go with the Sepolia fork rehearsal". The rehearsal runs the deployment and
milestones I1 and I4 on a local Anvil fork of Base Sepolia, ahead of the real run, which waits for
the owner's testnet wallet.

## Done

- **Package `services/apps/rehearsal` (`@chain/rehearsal`).** Run:
  `pnpm -r build && pnpm --filter @chain/rehearsal rehearse`.
  - **Fork:** Base Sepolia pinned a few blocks below head (chain id 84532 kept), with real Circle USDC (FiatToken v2), funded through its balance slot (9).
  - **Keys:** fresh throwaway keys per run, funded with fork ETH (see finding R1).
  - **Contracts:** the real `DeployBaseSepolia.s.sol` and `DeployTestnetVault.s.sol`, chain guards included. Broadcast artifacts go to a temporary directory, never `contracts/broadcast`. Then the factory admin and owner setup: `setDefaultVault`, `approveOwner`, `createEscrow`, `fundReserve`, `setRebalancer`, and the yield budget.
  - **Services:** every service runs as its own process with its production entry point: Ponder, the worker, the quote service, the rebalancer and ical-sync.
  - **KMS:** the quote service and the rebalancer run `SIGNER=kms` against `src/fakeKms.ts`. It is a loopback stand-in speaking KMS `GetPublicKey`/`Sign` (AWS JSON 1.1) through the real AWS SDK (`AWS_ENDPOINT_URL_KMS`). Half its signatures are high-s, as real KMS can return; @chain/signer normalises them.
  - **Report:** each run writes `docs/rehearsals/<date>-base-sepolia-fork.md`, with steps, gas per transaction, rebalancer actions and alerts.
- **Scenario (11 steps, all asserted):**
  1. Deploy.
  2. Services up.
  3. **I1:** offer, prepare, the guest sends the returned calls, `/v1/bookings` shows the booking via the indexer read model, another guest gets 403, then cancel-preview, cancel and claim refund in full.
  4. Bookings B and C.
  5. **Channel sync on 84532:** a loopback feed is refused, prepare fails closed, and the export carries B but not the cancelled A once safe.
  6. The rebalancer deploys finalised idle to the MockYieldVault (KMS-signed, live).
  7. **I4:** a 30-day warp; guest B's `accruedYieldAtomic` > 0 via `/v1/bookings` and the indexer summary.
  8. **7b:** cancel and claim C while funds are deployed.
  9. Settle B; the guest, payout and fee recipient claim in full (fee = exactly 5%).
  10. Reconciliation: no accounting invariant alert, and the nightly replay diffs clean.
- **C5 boot check (finding R1).** `assertSignerHasNoCode` in `quote-service/src/chain.ts`, called from `server.ts`, with 3 tests.

## Not done

- **The real Base Sepolia run** (wallet), I2 (agent workstream) and I3 (real listing).
- **No channel import.** The importer refuses non-HTTPS and loopback feeds off Anvil (correct), and the sandbox's egress proxy blocks public calendar hosts. Import is covered by C7's Anvil suites.
- **Base's L1 data fee is not measured.** Anvil does not charge it.

## Tests

- `pnpm --filter @chain/rehearsal rehearse`: 11/11 on four consecutive runs (pins 48118548 and later), after the fixes below; the committed report is from the last run.
- `pnpm --filter @chain/rehearsal test`: 2 tests (the KMS stand-in through the AWS SDK and `kmsAccount`; key redaction in reports).
- `pnpm --filter @chain/quote-service test`: 88 passed, 1 skipped (live APY).
- **Deployment gas, measured** (`docs/rehearsals/2026-10-14-base-sepolia-fork.md`):

  | Part | Gas |
  |---|---|
  | Libraries, Escrow implementation and factory | 9,131,556 |
  | MockYieldVault, seed included | 1,673,515 |
  | Admin and owner setup | 867,173 |
  | **Total** | **11,672,244** |

  At 0.006 gwei (Base Sepolia, 2026-10-14) the L2 execution is about 0.00007 ETH. Fund the deployer with ≥ 0.01 Sepolia ETH for the L1 data fee and headroom.

## Findings

- **R1: Anvil's public dev keys carry EIP-7702 delegations on Base Sepolia.**
  - All ten have code `0xef0100…`, set by third parties.
  - A delegated quote signer makes every quote revert `InvalidQuoteSignature`. That is by design: `SignatureChecker` asks code via ERC-1271 (C1 fork test `test_eip7702DelegatedSignerRejectsEcdsaQuotes`).
  - **Fix:** the quote service refuses to start when its signer has code, naming the delegate. Use a fresh KMS key.
  - **Owner action:** never use a dev key or a reused EOA for any role on Sepolia.
- **R2: a claim sent with gas = `eth_estimateGas` can run out of gas.**
  - **Evidence:**
    - In 3/3 runs the first post-settlement claims, sent without headroom, reverted. The call trace shows the final USDC `transfer` out of gas.
    - With a 20% margin the claim used 3.6% more than its estimate (123,655 → 128,051), in a transaction that emitted `YieldAccrued`.
    - A forge probe measured a claim that books an accrue() gain at +24,343 to +42,876 gas over one that does not (+26% to +46%).
  - **Mechanism:** the vault grows every second, and an estimate can miss a gain that the mined transaction books. The exact timing condition is not pinned down; the cancel-then-claim flow (7b) mined with a bare estimate in 3/3 runs.
  - **No funds are at risk.** The transaction reverts and a retry succeeds, but the user pays gas for the failure.
  - **Recommendation for the agent workstream** (the checkout executes `calls`):
    - submit `calls` atomically (EIP-5792 `wallet_sendCalls`) where the wallet supports it;
    - when sending one at a time, use `estimate + 60,000` gas.
  - The rehearsal does the same. The rebalancer already sends with estimate × 1.3.
- **R3: INV-5 fires during time warps.** A warp jumps past the window in which the rebalancer would have redeemed. The alert resolved before the end of every run. This is expected; no accounting invariant fired.
- **R4: the public Sepolia RPC timed out under fork load once.** Anvil now runs with `--retries 10 --timeout 60000`.

## Deviations from spec

- None.

## Spec concerns

- R2 touches the boundary in spec 11: the `/v1` `calls` objects carry `{to, data, value}` and no gas.

## Interfaces changed

- None. `/v1` is unchanged.
- The new boot check is internal to C5.
- `@chain/rehearsal` is a new private workspace package; it is not imported by any service.

## Blocked

- **Owner decision:** add an optional `gas` hint to `/v1` calls? It would need an ADR and the agent workstream's sign-off (spec 5.3). The default is no change, with R2 documented for the checkout.
- **The real Sepolia run** needs the owner's testnet wallet.
