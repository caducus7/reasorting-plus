# 0012: quote service policies (C5)

**Status:** Accepted with C5 (the project owner said to go with defaults). §6 and §7 touch the
agent workstream's contract and need its sign-off; until then they are the C5 defaults.
**Touches:** the `/v1` OpenAPI document (a 409 on `POST /v1/offers`, documentation only: the zod
schemas are unchanged); the Postgres tables `calendar_blocks` and `channel_feeds`, which C6 and C7
will write; the guest JWT claim contract (D7).

## 1. Policy materialisation and DST (spec 5.1)

Owners write rules in local terms ("full refund until 18:00, 30 days before arrival"). The
service turns each rule into a UTC instant in the property's IANA zone (Luxon). Two rules decide
wall-clock times that DST makes ambiguous:

- **A time in a spring-forward gap** (it never happens) maps to the first instant after the gap. That
  is what the wall clock reads when it jumps.
- **A time in a fall-back overlap** (it happens twice) maps to the **later** instant. The guest gets
  the longer window at the better refund tier, which matches refunds rounding up.

Check-in and check-out times use the same rules. The stay is validated against the same guards as
`deposit` (spec 4.2, guards 6, 7 and 11), and against the property's night limits.

## 2. Holds: one per slot, enforced by Postgres

- `holds` carries `EXCLUDE USING gist (resource_id WITH =, stay WITH &&) WHERE (active)`. Two
  overlapping active holds cannot exist.
- Creating a hold first takes a transaction-level advisory lock on the resource, keyed by the first
  8 bytes of `sha256("hold:" + resourceId)` through the documented `pg_advisory_xact_lock(bigint)`.
  - Without it, concurrent overlapping inserts can deadlock inside the exclusion check (40P01), and a
    guest gets a 500 instead of a 409. The C5 test suite found this.
  - PostgreSQL's executor source calls that deadlock "fairly harmless … although you get a different
    error message" (`execIndexing.c`). So this is about the error code, not safety.
  - The fix follows the PostgreSQL docs ("Deadlocks"): take the most restrictive lock first, in a
    consistent order. As the docs' second remedy, a transaction aborted with 40P01 or 40001 is
    retried, up to 3 attempts.
  - The exclusion constraint remains the backstop.
- Expired holds on the slot are released in the same transaction, before the insert.
- `POST /v1/offers` for a held or blocked slot returns **409 `unavailable`**. The C0 OpenAPI did not
  list a 409 on offers. The zod schemas already had the error code, and only the document changed.
  The agent workstream should confirm this.
- `resource_id` is canonical lowercase hex everywhere off-chain.

## 3. Quotes: one live quote per offer; a quoted hold ends only on proof

- Re-preparing with the same guest returns the same live quote. Another guest gets 409 `unavailable`
  while a quote is live. A row lock on the offer serialises concurrent prepares.
- Once the 25-minute offer lock has lapsed with no quote, prepare returns 409 `terms_changed`, and the
  guest takes a fresh offer.
- A quote lives for `QUOTE_TTL_SEC` (900 s), in **chain time**. It is the latest block's timestamp
  plus the TTL, as Uniswap's interface computes swap deadlines.
- **The hold awaits payment.** Once a quote is signed, the hold stops expiring on the server clock
  (`migrations/003`). The contract has no overlap check (spec 4.2, 9), so the slot may be released
  only on proof, never on a timer:
  - **Handed over:** the indexer (C6) has written the escrow booking into `calendar_blocks`, which
    takes over blocking the slot.
  - **Proven unpaid:** the chain's **safe** head is past the quote's `expiresAt`, and the booking does
    not exist at that block.
    - The escrow rejects an expired quote for good (`block.timestamp > expiresAt` gives
      `QuoteExpired`), so no deposit with that quote can appear later.
    - On the OP Stack every block up to the safe head is derived from the canonical L1 chain, so the
      sequencer cannot reorg it away (OP specs, `derivation.md`).
    - Measured on Base on 2026-09-27: safe trails latest by 15 blocks (about 30 s), so an unpaid slot
      frees about 30 s after its quote expires.
- **Precedent.** Stripe Checkout ends a session on the provider's authoritative `expired` state and
  events (`checkout.session.expired`; `async_payment_succeeded`/`_failed` for asynchronous methods),
  not on a merchant-side timer. The chain is our provider.
- **This replaces the earlier `HOLD_GRACE_SEC` (600 s).** That was a timer that assumed C6 indexes
  within 10 minutes. There is now no timing assumption about the indexer. A paid slot stays held
  until C6 projects it, however long that takes.
- **An expired quote ends its offer.** Prepare returns 409 `unavailable` until the quote is proven
  unpaid, then 409 `terms_changed`, and the guest takes a fresh offer. No replacement quote is ever
  signed for an offer, so a guest cannot pay twice.
- **Where proofs run.** They are evaluated lazily when availability, offers or prepare touch a slot
  with an awaiting hold. That costs one `eth_getBlockByNumber("safe")` and one `getBooking` per
  awaiting hold.

## 4. Fail closed

Prepare returns 409 `unavailable` and signs nothing when any of these holds:

- deposits are paused, or `lossDebt > 0`;
- the deposit would exceed `maxOpenPrincipalAtomic`;
- `calendar_blocks` shows an overlap (escrow bookings or channel imports);
- another guest's hold overlaps;
- any channel feed of the property last imported more than **`FEED_MAX_AGE_SEC` = 900 s** ago
  (brief: "record the threshold in an ADR"). A feed that has never been imported counts as stale.

Prepare returns 500 and signs nothing when any of these holds:

- the escrow's `quoteSigner` is not this service's key;
- chain time and the server clock differ by more than `MAX_CLOCK_SKEW_SEC` (120 s).
  - Why it matters: the offer lock and the stored quote's liveness use the server clock, while quote
    expiry uses chain time.
  - On Base, chain time tracks wall time by construction: one block every 2 s from genesis (OP specs,
    `derivation.md`). A larger gap therefore means a halted sequencer, a stale RPC node or a broken
    server clock, and prepare fails closed.
  - This is the off-chain counterpart of Aave's `PriceOracleSentinel` (an L2 sequencer-uptime gate).

## 5. Fees: live, and never straddling a change

`effectiveFeeBps`, `guestYieldBps`, `pendingFeeAt`, the pause flag, `lossDebt`, the cap and the
signer are all read at one pinned block number (the latest), so they are mutually consistent. If `pendingFeeAt` is in the
future, expiry is capped at `pendingFeeAt - 60`. Inside that last minute prepare returns 409
`terms_changed`. On Anvil, a pre-change quote used after the change reverts with `QuoteExpired`
(service quotes) or `FeeMismatch` (an uncapped quote).

## 6. Guest JWT claims (D7; needs agent-workstream sign-off)

- Algorithms: ES256 or EdDSA. The verification key comes from `JWT_PUBLIC_KEY_PEM` or `JWT_JWKS_URL`.
- `iss` and `aud` are required and must match the configured values. `exp` and `iat` are required,
  and a token older than 1 hour is refused.
- Exactly one identity claim is allowed:
  - `addr`: the booking's guest address after SIWE;
  - `email`: after a magic link. It matches the email given at prepare, case-insensitively.
- An unknown booking and someone else's booking both return 403 `forbidden`. Neither reveals
  whether the booking exists.

## 7. Shared tables with C6/C7

C5 reads these tables, and creates them if they are absent. C6 and C7 own their writes:

```sql
calendar_blocks(resource_id text, stay daterange, source text, ref text, PRIMARY KEY (resource_id, source, ref))
channel_feeds(resource_id text, feed_id text, last_success_at timestamptz, PRIMARY KEY (resource_id, feed_id))
```

- `source` is `'escrow'` with `ref` = bookingId, or a feed id with `ref` = the iCal UID.
- `stay` is `[checkInDate, checkOutDate)` in the property's local dates.
- Any change to these tables is a shared-schema change (CLAUDE.md §7).

## 8. Signer: AWS KMS by default

- The key is `ECC_SECG_P256K1`.
- The service signs the EIP-712 digest with `MessageType=DIGEST`, converts DER to (r, s) with low-s
  normalisation, and recovers v against the key's address.
- A local private-key signer exists for Anvil only. Config refuses it unless `CHAIN_ID=31337`, and
  it throws under `NODE_ENV=production`.
- The KMS key's address must never be EIP-7702-delegated. A delegated EOA is verified through
  ERC-1271 by `SignatureChecker`, which would hand quote validity to the delegate's code.

## 9. Interim read model

C6 owns the booking read model. Until it lands, `GET /v1/bookings/{id}`, cancel-preview and yield
terms read the escrow directly: views, plus indexed event lookups from `ESCROW_FROM_BLOCK`. It sits
behind the `BookingReadModel` interface so C6 can replace it. `GET /v1/yield/terms?bookingId` is
unauthenticated as in spec 5.3. It exposes what is already public on-chain.
