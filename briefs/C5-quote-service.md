# C5: Quote service and Service API

**Read first:** `CLAUDE.md`; `docs/chain-spec.md` sections 4.1 to 4.3, 5, 8, 11 and 14 (D7);
`docs/handoffs/C0.md`, `C1.md`.
**Depends on:** C1 ABI and EIP-712 types; C0's zod schemas (reuse them unchanged). Read endpoints
depend on C6; until C6 lands, back them with an interface and a fake.

## Goal

Replace the C0 stub with the real `/v1` Service API: policy materialisation, two-step offers,
signing with the escrow's `quoteSigner`, and the call bundle the checkout submits.

## In scope

- `services/apps/quote-service/` implementing all six endpoints in spec 5.3 against the C0 schemas.
- **Policy model and materialisation:** owner policy rules in local terms (for example "100% until
  18:00 local, 30 days before arrival"), converted to UTC cutoffs with Luxon using the property's
  IANA zone (`Europe/Athens` for the pilot). Validate monotonicity with the same rules as on-chain
  guard 11 before issuing.
- **Offers:** 25-minute price lock, one soft hold per resource per range, stored in Postgres.
- **Prepare:** re-check availability (calendar projection including imported channels), read the
  live `effectiveFeeBps()` and `guestYieldBps` from chain, cap `expiresAt` at
  `pendingFeeAt - 60s` if a fee change is pending, bind `guest`, sign EIP-712, return `quote`,
  `quoteSig`, and `calls` (`approve` + `deposit`). Store the guest email against `bookingId`.
- **Signer abstraction:** a `QuoteSigner` interface with a local-key implementation for dev and a
  KMS implementation for deployed environments (viem custom account). No private key ever in config
  for non-local environments.
- **Reference evaluator:** a TS implementation of spec 4.3 and 4.4 used for
  `refundIfCancelledNowAtomic` and `cancel-preview`. It must match the contract exactly (see the
  differential test below).
- **Yield estimate:** `estimatedGuestYieldAtomic` from the deployment window in spec 8, current APY
  from the adapter or market, labelled estimate, `asOf` timestamp.
- **Guest auth:** verify a JWT from the checkout backend (D7). Accept the issuer's public key via
  config. Don't build issuance.

## Out of scope

The checkout UI, the agent, email sending, magic-link issuance (all agent workstream). Indexing
(C6); consume its read models.

## Write these tests first

1. **Differential test:** fuzz random quotes and cancellation times through both the TS reference
   evaluator and the contract (via Anvil) and assert identical refund, fee and owner figures.
2. **DST:** policies whose local cutoff falls on the Europe/Athens DST transitions (last Sunday of
   March and October) materialise to the correct UTC instant.
3. **Fee straddle:** with a pending fee change, no issued quote expires after `pendingFeeAt`, and a
   deposit with a pre-change quote after the change reverts with the expected error.
4. **Signature:** a quote signed by the service is accepted by the C1 contract on Anvil; a
   tampered field is rejected.

## Acceptance

- Responses validate against the C0 schemas unchanged. Any schema change needs an ADR and agreement
  from the agent workstream.
- Concurrent offer requests for the same slot never produce two active holds.
- `feeBps` appears only inside `quote` in the prepare response.
- End to end on Anvil: offer, then prepare, then submit `calls` as a test smart wallet, and the
  booking exists on-chain with the expected terms.

## Watch for

- Never compute money with `number`.
- The service must never sign a quote with a fee other than the live one; read it at prepare time,
  not from a cache older than the current block.
- Prepare must fail closed if availability can't be confirmed (channel feed stale beyond a
  threshold). Record the threshold in an ADR.

## Handoff

`docs/handoffs/C5.md`, including how to run it against Anvil and Base Sepolia.
