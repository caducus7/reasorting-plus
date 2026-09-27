# Review 0003: C5 bug fixes against prior art

**Purpose:** the project owner asked for every bug fix to be checked against how established,
verified systems handle the same problem (the standard set in
[review 0002](0002-c9-findings-prior-art.md)). This covers the four fixes made during C5. Read on
2026-09-27.

**Sources:**
- `postgres/postgres@REL_16_STABLE`: `doc/src/sgml/{mvcc,func,ref/create_table,ref/drop_database}.sgml`
  and `src/backend/executor/execIndexing.c`. postgresql.org itself is blocked by this environment's
  network policy; these are the sources the docs are built from.
- `ethereum-optimism/specs@main`: `specs/protocol/derivation.md`.
- `stripe/openapi@master`: `openapi/spec3.json`. docs.stripe.com is blocked; the API spec carries
  Stripe's own field and event text.
- `Uniswap/interface@v4.266.2`: `src/hooks/useTransactionDeadline.ts`.
- `aave/aave-v3-core@master`: `contracts/protocol/configuration/PriceOracleSentinel.sol`.
- node-postgres `pg-pool@3.14.0`: `index.js`.
- A live Base mainnet RPC read.

## 1. Exclusion-constraint deadlock (40P01 instead of 409). Verdict: aligned, two refinements

**What PostgreSQL says.**
- The executor source explains the cause (`execIndexing.c:39-45`): two backends inserting
  conflicting rows "will find each other's tuple, and both try to wait for each other. The deadlock
  detector will detect that, and abort one of the transactions. That's fairly harmless, as one of
  them was bound to abort … anyway, although you get a different error message."
  - So there was never a safety issue: the exclusion constraint held.
  - The bug was only the error code.
- The docs' "Deadlocks" section (`mvcc.sgml`) gives two remedies:
  1. "acquire locks on multiple objects in a consistent order", taking "the most restrictive mode
     that will be needed" first;
  2. "retrying transactions that abort due to deadlocks".
- Advisory locks are documented for "pessimistic locking strategies". Transaction-level locks are
  "more convenient … for short-term usage".

**Our fix already matched remedy 1:** a transaction-level advisory lock per resource, taken first.

**Refinements made:**
- **Lock key.** It came from `hashtextextended()`, which is not in the documented function list
  (`func.sgml`) and so carries no stability guarantee. It is now computed in the service, as the first
  8 bytes of `sha256("hold:" + resourceId)`, and passed to the documented
  `pg_advisory_xact_lock(key bigint)`.
- **Retry.** Remedy 2 is added as a backstop: up to 3 attempts on 40P01 or 40001.

## 2. Hold released 600 s after quote expiry (indexer grace). Verdict: not aligned, replaced

**What was wrong.** The grace was a local timer plus a margin, and it assumed the indexer (C6)
catches up within 10 minutes. If that assumption failed, a paid slot could be sold twice. The escrow
has no overlap check.

**Prior art.**
- **Stripe Checkout** ends a session on the provider's authoritative state. `status` is "one of
  `open`, `complete`, or `expired`". There are events for `checkout.session.expired` and, for
  asynchronous payment methods, `checkout.session.async_payment_succeeded`/`_failed`.
- The merchant acts on those, not on its own timer. For us the provider is the chain, and its
  terminal states can be proven:
  - **Expired for good:** the escrow rejects a quote once `block.timestamp > expiresAt`
    (`QuoteExpired`). After the chain passes `expiresAt`, that quote can never be deposited.
  - **Reorg-safe:** the OP Stack spec (`derivation.md`) defines the safe L2 head as the point where
    "everything up to and including this block can be fully derived from the currently canonical L1
    chain".
  - **Therefore:** if the safe head's timestamp is past `expiresAt` and the booking is absent at that
    block, the quote is proven unpaid.
- **Measured on Base mainnet on 2026-09-27:** latest 51,864,184 and safe 51,864,169, so 15 blocks
  (30 s) apart. The proof arrives about 30 s after expiry, sooner than the 600 s grace.

**The fix:**
- A quoted hold stops expiring on the server clock (`migrations/003`).
- It is released only when one of two things is proven:
  - **handed over:** C6 wrote the escrow booking into `calendar_blocks`;
  - **proven unpaid:** the safe-head rule above.
- An expired quote ends its offer, and no replacement quote is ever signed.
- If the chain cannot be read, there is no proof: the hold stays and the endpoints still answer.

**Tests:**
- App tests: the proof timing; a paid slot held for a day with no indexer; handover to
  `calendar_blocks`; no re-quote.
- Anvil test: Anvil's real `safe` tag (latest − 32). The slot stays held while latest is past expiry
  and safe is not, and frees once safe passes it. A deposited but never-indexed slot stays held.

## 3. Refuse to sign when chain time and server clock differ by more than 120 s. Verdict: aligned, no change

**Prior art.**
- **Chain-time deadlines are standard.** Uniswap's interface computes a swap deadline as
  `blockTimestamp.add(ttl)` (`useTransactionDeadline.ts`), which is how our quote expiry works.
- **Base time tracks wall time by construction.** `block.timestamp = prev_l2_timestamp +
  l2_block_time` (2 s), and "there must be an L2 block every `l2_block_time` seconds". The L2 clock
  can run at most `max_sequencer_drift` (1,800 s) ahead of its L1 origin.
- **So a large skew is a fault, not drift.** It means a halted sequencer, a stale RPC node or a broken
  server clock.
- **Aave gates operations on L2 sequencer health.** `PriceOracleSentinel` uses a sequencer-uptime
  oracle plus a grace period. Our guard is the off-chain counterpart, and failing closed is the same
  posture.

## 4. Test database teardown killed closing connections. Verdict: aligned, no change

**Cause and fix.**
- `DROP DATABASE … FORCE` will "terminate all existing connections to the target database"
  (`drop_database.sgml`).
- pg-pool's `end()` resolves when its client list is empty, but `_remove()` calls `client.end()`
  without waiting (`index.js`, pg-pool 3.14.0). So backends can briefly outlive `end()`.
- The fix retries a plain `DROP`, which refuses with 55006 while connections remain, and keeps
  `FORCE` as a last resort. It relies on documented behaviour on both sides.

## Test results after the changes

```
cd services && pnpm -r test          abi up to date; shared 32; api-stub 49; quote-service 71
  (the quote-service suite ran 5 times with the concurrency tests: all passed, no unhandled errors)
cd services/apps/quote-service && pnpm test:anvil    5 passed
```
