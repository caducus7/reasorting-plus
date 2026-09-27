-- Holds awaiting payment (docs/adr/0012 §3 as amended). Once a quote is signed, the hold no longer
-- expires on the server clock: it is released only on proof, like a Stripe Checkout Session that
-- ends on the provider's authoritative `expired` state rather than a local timer.
--   * handed over: the indexer (C6) wrote the escrow booking into calendar_blocks, or
--   * proven unpaid: the chain's safe head is past the quote's expiry (the escrow then rejects the
--     quote forever) and the booking does not exist at that block.
ALTER TABLE holds
  ADD COLUMN awaiting_booking_id text,    -- the signed quote's bookingId
  ADD COLUMN awaiting_until      bigint;  -- the quote's expiresAt, chain time (unix seconds)

CREATE INDEX holds_awaiting ON holds (resource_id) WHERE active AND awaiting_booking_id IS NOT NULL;
