# 0003: claim path in the Service API

**Status:** Proposed by C0. Needs agent-workstream sign-off. Resolves review 0001 finding 6.
**Touches:** `BookingResponse` and `CancelPreviewResponse` in the shared `/v1` schema.

## Context

Settlement credits claimable balances and never transfers (spec 3.5, 4.5). A guest receives a
refund or vested yield only by calling `claim()`. Spec 5.3 exposes neither the balance nor a claim
call, so the section 11 end-to-end flow ("cancel ... check status") never actually pays the guest.

## Decision

1. `GET /v1/bookings/{id}` adds:
   - `claimableAtomic`: the guest's claimable balance on this escrow
   - `claimCalls`: `[claim()]` when `claimableAtomic > 0`, else `[]`
2. `POST /v1/bookings/{id}/cancel-preview` returns `calls` = `[cancelByGuest(bookingId), claim()]`.
   A smart wallet submits both in one batch, and the refund arrives in the same user operation.
   An EOA submits them in order.

`claim()` pays `min(claimable, liquid)`, and a shortfall in liquidity makes it pay partially rather
than revert (spec 4.5). A partial claim leaves the rest visible in `claimableAtomic`.

**Caveat:** `claim()` can still revert. A USDC-blacklisted guest's transfer reverts (spec 4.5), and
so does a guest address that is also the escrow's payout address while `lossDebt > 0`. In an atomic
batch that would undo the cancellation too. So the checkout must simulate the bundle and, if it
reverts, submit `cancelByGuest` alone. C1 must also decide whether `claim()` with zero claimable
reverts; the bundle assumes it does not revert when claimable is non-zero.

## Consequences

`claimableAtomic` is per guest address, per escrow (the contract's `claimable[guest]`), not per
booking. With one booking per guest per escrow they are the same. C6 must serve it from the ledger
projection at the `finalized` head (spec 10.2).
