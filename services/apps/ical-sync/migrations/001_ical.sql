-- C7 state. The shared calendar_blocks / channel_feeds tables and the alert outbox come from the
-- indexer's migration (indexer_ops), which runs first.
CREATE SCHEMA IF NOT EXISTS ical_sync;

-- Per-feed poll state: validators for conditional GET, back-off, the last outcome.
CREATE TABLE IF NOT EXISTS ical_sync.feed_state (
  feed_id          text        PRIMARY KEY,
  resource_id      text        NOT NULL,
  etag             text,
  last_modified    text,
  failures         integer     NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_attempt_at  timestamptz,
  last_status      text,
  last_error       text,
  last_warnings    text[]      NOT NULL DEFAULT '{}'
);

-- Conflict log (brief: "log every conflict with timestamps"): one open row per (booking, channel
-- event); last_seen moves on every poll that still sees it; resolved when it no longer overlaps.
CREATE TABLE IF NOT EXISTS ical_sync.conflicts (
  id             bigserial   PRIMARY KEY,
  resource_id    text        NOT NULL,
  escrow         text        NOT NULL,
  booking_id     text        NOT NULL,
  source         text        NOT NULL,
  ref            text        NOT NULL,
  booking_stay   daterange   NOT NULL,
  block_stay     daterange   NOT NULL,
  alert_key      text        NOT NULL,
  first_seen_at  timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  resolved_at    timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS conflicts_open ON ical_sync.conflicts (booking_id, source, ref) WHERE resolved_at IS NULL;
