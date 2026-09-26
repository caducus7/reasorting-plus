-- Quote service schema (C5). Keys are (chain_id, escrow, booking_id) everywhere (ADR 0009 §5).
-- btree_gist is a trusted extension (PostgreSQL 13+), so the database owner can create it.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Unsigned offers with a 25-minute price lock (spec 5.2).
CREATE TABLE offers (
  offer_id      uuid PRIMARY KEY,
  chain_id      integer     NOT NULL,
  escrow        text        NOT NULL,
  resource_id   text        NOT NULL,
  check_in      date        NOT NULL,
  check_out     date        NOT NULL,
  guests        integer     NOT NULL CHECK (guests > 0),
  price_atomic  numeric(78, 0) NOT NULL CHECK (price_atomic > 0),
  policy_id     text        NOT NULL,
  session_id    text,
  created_at    timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL
);

-- Soft holds. The exclusion constraint is what guarantees "one active soft hold per resource per
-- date range" (spec 5.2) under concurrency: two overlapping active holds cannot both commit.
-- A hold's `expires_at` covers the offer lock and, once prepared, the signed quote's lifetime.
CREATE TABLE holds (
  offer_id     uuid PRIMARY KEY REFERENCES offers (offer_id),
  resource_id  text        NOT NULL,
  stay         daterange   NOT NULL,
  expires_at   timestamptz NOT NULL,
  active       boolean     NOT NULL DEFAULT true,
  CONSTRAINT one_active_hold_per_slot EXCLUDE USING gist (resource_id WITH =, stay WITH &&) WHERE (active)
);

-- Signed quotes. At most one unexpired quote per offer: a second valid quote for the same hold
-- could let two guests deposit for the same slot, and the contract has no overlap check.
-- The guest's email lives here, never on-chain (spec 5.2).
CREATE TABLE quotes (
  chain_id     integer     NOT NULL,
  escrow       text        NOT NULL,
  booking_id   text        NOT NULL,
  offer_id     uuid        NOT NULL REFERENCES offers (offer_id),
  guest        text        NOT NULL,
  email        text        NOT NULL,
  session_id   text,
  quote        jsonb       NOT NULL,
  quote_sig    text        NOT NULL,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL,
  PRIMARY KEY (chain_id, escrow, booking_id)
);
CREATE INDEX quotes_offer ON quotes (offer_id, expires_at);

-- Calendar projection, OWNED BY C6/C7 (docs/adr/0012). Created here only if absent, so the service
-- runs before those packages land. C5 reads it; it never writes it.
CREATE TABLE IF NOT EXISTS calendar_blocks (
  resource_id  text      NOT NULL,
  stay         daterange NOT NULL,
  source       text      NOT NULL,   -- 'escrow' or a channel feed id
  ref          text      NOT NULL,   -- bookingId or iCal UID
  PRIMARY KEY (resource_id, source, ref)
);
CREATE INDEX IF NOT EXISTS calendar_blocks_stay ON calendar_blocks USING gist (resource_id, stay);

CREATE TABLE IF NOT EXISTS channel_feeds (
  resource_id      text        NOT NULL,
  feed_id          text        NOT NULL,
  last_success_at  timestamptz,
  PRIMARY KEY (resource_id, feed_id)
);
