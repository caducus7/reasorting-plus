-- Worker-owned tables (C6). Idempotent: run at every worker start. Projection state lives only in
-- Ponder's schema; these tables hold observations (chain heads), outboxes and the shared calendar.

CREATE SCHEMA IF NOT EXISTS indexer_ops;

-- Head tracker (docs/adr/0014 gap 1): the chain's own latest/safe/finalized tags, never Ponder's.
CREATE TABLE IF NOT EXISTS indexer_ops.chain_heads (
  chain_id    integer     NOT NULL,
  tag         text        NOT NULL CHECK (tag IN ('latest', 'safe', 'finalized')),
  number      bigint      NOT NULL,
  hash        text        NOT NULL,
  ts          bigint      NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, tag)
);

-- Outbox of head transitions (brief: "publish head-transition events"). Also NOTIFY chain_head.
CREATE TABLE IF NOT EXISTS indexer_ops.head_events (
  id          bigserial   PRIMARY KEY,
  chain_id    integer     NOT NULL,
  tag         text        NOT NULL,
  number      bigint      NOT NULL,
  hash        text        NOT NULL,
  ts          bigint      NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Outbox of per-booking head milestones (spec 10.2). Consumers: C7 export (safe), notifier
-- confirmation email (finalized), guest status (received). 'reverted' when a deposit that had a
-- milestone left the canonical chain. Also NOTIFY booking_milestone.
CREATE TABLE IF NOT EXISTS indexer_ops.booking_milestones (
  id             bigserial   PRIMARY KEY,
  chain_id       integer     NOT NULL,
  escrow         text        NOT NULL,
  booking_id     text        NOT NULL,
  milestone      text        NOT NULL CHECK (milestone IN ('received', 'safe', 'finalized', 'reverted')),
  deposit_block  bigint      NOT NULL,
  deposit_hash   text        NOT NULL,
  head_number    bigint      NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, escrow, booking_id, deposit_hash, milestone)
);

-- Alert outbox for the pluggable notifier (spec 10.4). One open alert per dedupe key; a cleared
-- condition resolves it so a recurrence alerts again.
CREATE TABLE IF NOT EXISTS indexer_ops.alerts (
  id           bigserial   PRIMARY KEY,
  dedupe_key   text        NOT NULL,
  invariant    text        NOT NULL,
  severity     text        NOT NULL CHECK (severity IN ('page', 'alert', 'warn')),
  chain_id     integer     NOT NULL,
  escrow       text,
  message      text        NOT NULL,
  details      jsonb       NOT NULL DEFAULT '{}',
  response     text[]      NOT NULL DEFAULT '{}',
  opened_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open ON indexer_ops.alerts (dedupe_key) WHERE resolved_at IS NULL;

-- Shared calendar (docs/adr/0012 §3 and §7), owned by C6/C7; identical to the quote service's
-- IF NOT EXISTS copy. C6 writes source = 'escrow' rows; C7 writes channel rows.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE IF NOT EXISTS calendar_blocks (
  resource_id  text      NOT NULL,
  stay         daterange NOT NULL,
  source       text      NOT NULL,
  ref          text      NOT NULL,
  PRIMARY KEY (resource_id, source, ref)
);
CREATE INDEX IF NOT EXISTS calendar_blocks_stay ON calendar_blocks USING gist (resource_id, stay);
CREATE TABLE IF NOT EXISTS channel_feeds (
  resource_id      text        NOT NULL,
  feed_id          text        NOT NULL,
  last_success_at  timestamptz,
  PRIMARY KEY (resource_id, feed_id)
);
