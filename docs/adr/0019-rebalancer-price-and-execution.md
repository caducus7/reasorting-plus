# 0019: rebalancer price source, liquidity source and execution (C8)

**Status:** Accepted with C8. It implements spec 6.7 and the C8 brief. Tests are named in
`docs/handoffs/C8.md`.

## 1. USDC price for the depeg gate: Chainlink USDC/USD on Base

**Feed:** `0x7e860098F58bBFC8648a4311b374B1D669a2bc6B`.
- Source: `bgd-labs/aave-address-book` `ChainlinkBase.USDC__USD` at commit `17567521`. Chainlink's
  own docs site was unreachable from the build environment's egress policy.
- Checked on-chain: `description() == "USDC / USD"`, `decimals() == 8`, answer 0.99988320 at Base
  block 51,944,820.
- The service re-checks description and decimals at start and refuses a mismatched feed. That check
  is tested: pointing it at the sequencer feed is refused.

**Why not Aave's own oracle.** `AaveV3Base.USDC_ORACLE` is a **"Capped USDC/USD"** adapter. A cap
hides an upward move, and the gate must see a depeg in both directions.

**Heartbeat, measured.** The last 13 rounds are 86,414–86,432 s apart, so the heartbeat is 24 h. No
deviation-triggered rounds occurred in that window. **Staleness:** a price older than 90,000 s
(24 h plus a 1 h margin) is stale, and a stale price halts deployment.

The feed's deviation threshold could not be read here, because the docs are blocked. The ±1% gate
is only as good as the feed's deviation trigger. **Before mainnet, confirm that trigger is below
1%**; otherwise lower `MAX_PRICE_AGE_SEC` so the heartbeat bounds the delay instead.

**L2 sequencer (Chainlink's L2 guidance).** The sequencer uptime feed is
`0xBCF85224fc0756B9Fa45aA7892530B47e10b6433`.
- Sources: Chainlink documentation repo `src/content/data-feeds/l2-sequencer-feeds.mdx` at commit
  `98c02658`, and aave-address-book `ChainlinkBase.L2_Sequencer_Uptime_Status_Feed`.
- Checked on-chain: `description() == "L2 Sequencer Uptime Status Feed"`, answer 0 (up).
- Rules: `answer != 0` means down. Within 3,600 s of `startedAt` is the grace period, the value in
  Chainlink's example consumer.

**Any doubt stops deployment only.** A down sequencer, the grace period, an unreadable feed, a
non-positive answer or a bad timestamp all return `{ ok: false }`, and the only effect is "no
deploy". **The price never causes a redeem** (spec 6.7). This is tested as a property: no price
value can turn a hold or a deploy into a redeem.

**Testnets and Anvil.** `PRICE_SOURCE=fixed` gives a constant $1.00. It is refused on Base mainnet.

## 2. Market available liquidity

- **Aave (production):** `Pool.getVirtualUnderlyingBalance(USDC)`. This is the figure that caps
  StataTokenV2's `maxWithdraw` (ADR 0016).
- **MockYieldVault (testnet):** its `withdrawLimit()` stands in for the market. No limit set means an
  unconstrained market, and setting a limit demonstrates a crunch.
  - The vault's own balance cannot be the measure: after our deposit it is mostly our money, so the
    20x gate could never pass.
  - With OpenZeppelin 5.6's `maxWithdraw = previewRedeem(maxRedeem)`, a limit of a few atomic units
    rounds to 0 withdrawable. The rebalancer then holds with `cannot_redeem` and an alert.
  - `mock-vault` is refused on Base mainnet.

## 3. What the policy decides on

`src/policy.ts` is one pure function over a snapshot, with every check recorded, so a decision is
explainable from the log alone.

**The snapshot:**
- Escrow and vault reads are pinned to one block `B`.
- `idleFinalized` is the escrow's USDC balance at the chain's `finalized` tag. The amount deployable
  is taken from `min(idle, idleFinalized)`, so only finalised deposits count (spec 6.7, 10.2).
- An escrow younger than the finalized head counts as having nothing finalized.
- **Required liquid (spec 6.7):** C6's `requiredLiquid`, over the larger of each liability total at
  `latest` and at `finalized`, plus every open booking in the projection, finalized or not. The value
  is published to `rebalancer.required_liquid`. C6's INV-5 computes it independently with the same
  function.

**Deploy amount:** `min(excess, buffer room, maxDeployBps room, liquidity room)`, where the
liquidity room comes from `available + a >= 20 (position + a)`. The amount must be at least
500 USDC, and it must pass an exact replica of `LedgerLib.deploy`'s checks, which is a backstop that
the bounds never hit. A projection more than 60 blocks behind stops deployment.

## 4. Execution: one transaction in flight, replaced safely, no loops

- **Pre-check:** every move is first simulated (`eth_call`) as the rebalancer. A revert, whether in
  the pre-check or on-chain, puts that `kind:reason` on a cooldown: 10 min, doubling, capped at 6 h,
  and cleared by a success. It never loops.
- **Write-ahead:** the signed transaction is stored in `rebalancer.pending_tx` **before** it is
  broadcast. A crash in between rebroadcasts the same bytes, never a new transaction.
- **Replacement:** a transaction unmined after 180 s is re-decided.
  - If the decision still holds, the **same call at the same nonce** is resent with fees at least
    12.5% higher (the client replacement rule).
  - If it no longer holds (say the price left the band), a **0-value self-transfer at the same
    nonce** cancels it.

  Only one transaction can mine per nonce, so a replacement can never double-deploy.
- **Nonce taken externally:** if the nonce was used by a transaction we did not record, that is
  detected and logged. Only one process may drive an escrow (a Postgres advisory lock).
- **Dry run** is the default in every environment. Only `DRY_RUN=false` sends.
- **Signer:** the same KMS path as C5's quote signer. `@chain/signer` was extracted from the quote
  service, and `kmsAccount` signs transactions through `signDigest`, with DER converted to low-s and
  the recovery bit checked. Local keys are Anvil-only.
